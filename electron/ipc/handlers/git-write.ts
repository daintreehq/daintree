// eager-import-allow: reads git config via store.get synchronously while servicing git-write IPC
import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import {
  checkRateLimit,
  typedHandle,
  typedHandleWithContext,
  sendToRendererContext,
} from "../utils.js";
import {
  getOperationRegistry,
  normalizeOperationId,
  untrackedOperationHandle,
  type OperationHandle,
} from "../../services/operations/index.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import { readRemoteBranchTip } from "../../utils/remoteBranchTip.js";
import type { GitPushPayload, PushProgressEvent } from "../../../shared/types/ipc/gitPush.js";
import type {
  ConflictedFileEntry,
  GitBaseIntegrationBlocker,
  GitBaseIntegrationCommitPreview,
  GitBaseIntegrationKind,
  GitCommitResult,
  GitCommitReview,
  GitPushCommitPreview,
  GitPullRebaseReview,
  GitPushReview,
  GitRebaseCommitPreview,
  GitRemoteCommitPreview,
  GitStatus,
  RebaseSequence,
  RepoOperationPin,
  RepoState,
  StagingStatus,
} from "../../../shared/types/git.js";
import { GIT_REMOTE_COMMIT_PREVIEW_MAX } from "../../../shared/types/git.js";
import {
  validateCwd,
  createHardenedGit,
  createAuthenticatedGit,
  createContinueGit,
  createStrictExitGit,
} from "../../utils/hardenedGit.js";
import {
  batchPathGroupsForArgv,
  getPerFileDiffStats,
  invalidateStagingDiffStatCache,
  resolveHeadOidFromGitDir,
} from "../../utils/git.js";
import { resolveGitDirFromFs } from "../../utils/gitUtils.js";
import { parsePorcelainV1Z } from "../../services/git/fileMutation.js";
import { withTimeout } from "../../utils/withTimeout.js";
import { runExclusive } from "../../utils/keyedMutex.js";
import {
  resolveExistingBaseCompareTarget,
  type ExistingBaseCompareTarget,
} from "../../utils/baseCompareRef.js";
import { store } from "../../store.js";
import { getSoundService } from "../../services/getSoundService.js";
import type * as SoundServiceModule from "../../services/SoundService.js";
import {
  detectRepoOperationState,
  readCurrentRepoOperationId,
  readRepoOperationId,
  resolveGitDir,
} from "../../services/git/repoOperationState.js";
import { RESOLVE_UNDO_ARGS, parseResolveUndoPaths } from "../../services/git/resolveUndo.js";
import {
  parsePorcelainV2Conflicts,
  PORCELAIN_V2_CONFLICT_ARGS,
} from "../../services/git/porcelainConflicts.js";
import {
  STAGED_FILE_SIZE_CAP,
  scanConflictMarkerText,
  scanStagedFilesForConflictMarkers,
} from "../../services/git/conflictMarkerScan.js";
import { EMPTY_TREE } from "../../services/git/reviewPoint/captureReviewPoint.js";
import { isProjectIoError, projectIo } from "../../services/projectIoGate.js";
import { readCommitStagedIdentity, readStagedSnapshot } from "../../services/git/stagedSnapshot.js";
import { shouldPlayUiFeedbackSound } from "../../utils/uiFeedbackSound.js";
import { resolveExecutableForSpawn } from "../../utils/windowsExecutable.js";
import { getSanitizedProcessEnv } from "../../utils/gitEnv.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
  if (!shouldPlayUiFeedbackSound(store.get("notificationSettings"))) return;
  void getSoundService()
    .then((svc) => svc.play(id))
    .catch((err) => console.error("[git-write] sound play failed:", err));
}
import type {
  ConflictMarkerScanEntry,
  GitScanConflictMarkersPayload,
  GitCheckoutOursTheirsPayload,
} from "../../../shared/types/ipc/git.js";
import { classifyGitError } from "../../../shared/utils/gitOperationErrors.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { AppError, GitOperationError } from "../../utils/errorTypes.js";
import { logWarn } from "../../utils/logger.js";
import {
  resolveGitPushDestination,
  resolveGitPushAndUpstream,
  resolveGitUpstream,
  formatGitPushDestination,
  describeUnresolvedPushDestination,
  describeUnresolvedUpstream,
  type ResolvedGitPushDestination,
} from "../../utils/gitPushDestination.js";

const execFileAsync = promisify(execFile);

function classifyGitFailure(error: unknown, formattedMessage: string) {
  const reason = classifyGitError(error);
  return reason === "unknown" ? classifyGitError(formattedMessage) : reason;
}

function encodeGitOperationErrorMessage(
  reason: ReturnType<typeof classifyGitFailure>,
  message: string,
  fields: { leaseSha?: string; branchName?: string } = {}
): string {
  const leaseSha = fields.leaseSha ? encodeURIComponent(fields.leaseSha) : "";
  const branchName = fields.branchName ? encodeURIComponent(fields.branchName) : "";
  return `[GitError|${reason}|${leaseSha}|${branchName}] ${message}`;
}

interface StagingFileEntry {
  path: string;
  status: GitStatus;
  insertions: number | null;
  deletions: number | null;
}

/**
 * `git rev-list --count <rev spec>`. Falls back to 0 on unparseable output, which
 * renders as "no hidden tail" rather than a wrong count — the rows themselves
 * are still shown, so the preview degrades quietly instead of overstating.
 *
 * Takes the rev spec as an argument LIST rather than one range string: a push
 * that creates a remote branch has no `a..b` range to measure and is expressed
 * as `<branch> --not --remotes=<remote>` instead. Both forms have to reach
 * `rev-list` unsplit, or a two-word spec would arrive as one bogus revision.
 */
async function countCommitsInRange(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  revArgs: readonly string[]
): Promise<number> {
  const out = await git.raw(["rev-list", "--count", ...revArgs]);
  const parsed = Number.parseInt(out.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Resolve the remote ref a write acts on, or refuse the write (#11746).
 *
 * Every remote-mutating path routes through here so that "we could not work out
 * where this goes" can never degrade into "send it to origin" — a wrong-repo
 * push is not recoverable. The thrown message is worded to land in the existing
 * `config-missing` bucket, so the renderer already has a recovery hint for it.
 *
 * `target` selects the resolver AND its wording together, so a pull-rebase can
 * never be refused in push terms.
 */
async function requireRemoteTarget(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw" | "getRemotes">,
  branchName: string,
  cwd: string,
  op: string,
  target: "push" | "upstream" = "push"
): Promise<ResolvedGitPushDestination> {
  const resolution = await (target === "upstream"
    ? resolveGitUpstream(git, branchName)
    : resolveGitPushDestination(git, branchName));
  if (resolution.status === "resolved") return resolution.destination;

  const message =
    target === "upstream"
      ? describeUnresolvedUpstream(resolution.reason, branchName)
      : describeUnresolvedPushDestination(resolution.reason, branchName);
  throw new GitOperationError(
    "config-missing",
    encodeGitOperationErrorMessage("config-missing", message, { branchName }),
    { cwd, op, rawMessage: message, branchName }
  );
}

/**
 * The destination a reviewed push may write to, or a refusal (#15646).
 *
 * The confirm showed one branch, at one commit, going to one destination, and
 * agents keep working in the worktree while it is open. So each of the three is
 * read again here and compared, and any difference refuses the push without
 * touching the network. Nothing is reconciled: re-resolving and pushing
 * whatever is true now is the "if X changed, use Y" substitution the
 * destructive-action rules forbid, and the push that was approved no longer
 * exists. A destination that no longer resolves is a change like any other.
 *
 * The remote side is deliberately NOT compared. A destination that moved is
 * git's ordinary non-fast-forward rejection, which captures the lease the
 * force-push recovery needs; refusing it here would take that recovery away.
 */
async function requireReviewedTarget(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw" | "getRemotes">,
  branchName: string,
  review: GitPushReview,
  cwd: string
): Promise<ResolvedGitPushDestination> {
  if (branchName !== review.branch) {
    throw pushReviewStaleError(
      cwd,
      branchName,
      branchName === "HEAD"
        ? `this worktree is on a detached HEAD, not '${review.branch}'`
        : `this worktree switched from '${review.branch}' to '${branchName}'`
    );
  }
  const reviewed = formatGitPushDestination(review.destination);
  const resolution = await resolveGitPushDestination(git, branchName);
  if (resolution.status !== "resolved") {
    throw pushReviewStaleError(
      cwd,
      branchName,
      `'${branchName}' no longer has a push destination (it was ${reviewed})`
    );
  }
  const destination = resolution.destination;
  if (
    destination.remote !== review.destination.remote ||
    destination.branch !== review.destination.branch
  ) {
    throw pushReviewStaleError(
      cwd,
      branchName,
      `'${branchName}' now pushes to ${formatGitPushDestination(destination)}, not ${reviewed}`
    );
  }
  const tip = await readOid(git, `refs/heads/${branchName}`);
  if (tip?.toLowerCase() !== review.headOid) {
    throw pushReviewStaleError(
      cwd,
      branchName,
      tip ? `'${branchName}' moved to a different commit` : `'${branchName}' no longer exists`
    );
  }
  return destination;
}

/**
 * The arguments for a push that writes exactly one branch to `destination`.
 *
 * A bare `git push` sends whatever the repository's config says, which can be
 * far more than the one branch every push confirm shows (#15556):
 * `push.default=matching` or a `remote.<name>.push` wildcard publishes every
 * other branch's unpushed commits, and a mirror remote is rewritten wholesale.
 * A refspec on the command line overrides the first two and makes git refuse a
 * mirror remote outright; the flags keep `push.followTags` and
 * `push.recurseSubmodules` from adding tags or submodule pushes nobody saw.
 *
 * Fully qualified on both sides: a short `topic` is ambiguous against a local
 * tag of the same name, and on the remote side can resolve to a tag instead of
 * the branch. No `--` separator, because simple-git appends its own flags after
 * these arguments; the remote name is already guarded against leading dashes.
 */
function singleBranchPushArgs(
  branchName: string,
  destination: ResolvedGitPushDestination
): string[] {
  return [
    "--no-follow-tags",
    "--recurse-submodules=no",
    destination.remote,
    `refs/heads/${branchName}:refs/heads/${destination.branch}`,
  ];
}

/**
 * The arguments for a push that writes the reviewed COMMIT to `destination`.
 *
 * The commit, not the branch: a commit an agent lands after the final check
 * but before git reads `refs/heads/<branch>` would otherwise ride along under
 * an approval that never showed it (#15646). No `+`, so the remote still only
 * fast-forwards, and a destination that moved meanwhile is git's ordinary
 * non-fast-forward rejection. `^{commit}` so no ref spelled like the OID can
 * stand in for it.
 */
function reviewedCommitPushArgs(
  headOid: string,
  destination: ResolvedGitPushDestination
): string[] {
  return [
    "--no-follow-tags",
    "--recurse-submodules=no",
    destination.remote,
    `${headOid}^{commit}:refs/heads/${destination.branch}`,
  ];
}

const FULL_OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * The review a push payload carries, or `null` when it carries none.
 *
 * All four fields or none. A partial record is refused rather than enforced
 * field by field: a caller that sent the branch and commit but lost the
 * destination would otherwise get a push pinned on two axes and free on the
 * third, which reads as "reviewed" while publishing somewhere nobody saw.
 */
function readPushReview(payload: GitPushPayload): GitPushReview | null {
  const fields = [
    payload.expectedBranch,
    payload.expectedHeadOid,
    payload.expectedRemote,
    payload.expectedRemoteBranch,
  ];
  if (fields.every((field) => field === undefined)) return null;
  const [branch, headOid, remote, remoteBranch] = fields;
  if (
    typeof branch !== "string" ||
    !branch ||
    typeof headOid !== "string" ||
    !FULL_OID_PATTERN.test(headOid) ||
    typeof remote !== "string" ||
    !remote ||
    typeof remoteBranch !== "string" ||
    !remoteBranch
  ) {
    throw new AppError({ code: "VALIDATION", message: "Invalid push review" });
  }
  return {
    branch,
    headOid: headOid.toLowerCase(),
    destination: { remote, branch: remoteBranch },
  };
}

/**
 * The branch and commit a pull-and-rebase payload pins, or `null` when it pins
 * neither (#17188).
 *
 * Both or neither, for the reason push takes all four: a pin that kept the
 * commit but lost the branch would pass a checkout of another branch sitting on
 * the same commit, and rebase a branch nobody saw named.
 */
function readPullRebaseReview(payload: {
  expectedBranch?: unknown;
  expectedHeadOid?: unknown;
}): GitPullRebaseReview | null {
  const { expectedBranch: branch, expectedHeadOid: headOid } = payload;
  if (branch === undefined && headOid === undefined) return null;
  if (
    typeof branch !== "string" ||
    !branch ||
    typeof headOid !== "string" ||
    !FULL_OID_PATTERN.test(headOid)
  ) {
    throw new AppError({ code: "VALIDATION", message: "Invalid pull and rebase review" });
  }
  return { branch, headOid: headOid.toLowerCase() };
}

function pullRebaseReviewStaleError(
  cwd: string,
  branchName: string,
  detail: string
): GitOperationError {
  const message = `The branch changed since this pull and rebase was previewed: ${detail}. Nothing was rebased. Pull and rebase again to see what it would replay now.`;
  return new GitOperationError(
    "pull-rebase-review-stale",
    encodeGitOperationErrorMessage("pull-rebase-review-stale", message, { branchName }),
    { cwd, op: "pull-rebase", rawMessage: message, branchName }
  );
}

/**
 * The branch HEAD names, or `null` on a detached HEAD.
 *
 * Read through `symbolic-ref` rather than `rev-parse --abbrev-ref`, which
 * answers `heads/topic` when a tag is also called `topic`. The preview names
 * the branch `topic`, so comparing against the abbreviated spelling would
 * refuse an unchanged worktree, and no fresh preview could ever repair it.
 */
async function readHeadBranch(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">
): Promise<string | null> {
  try {
    const ref = (await git.raw(["symbolic-ref", "--quiet", "HEAD"])).trim();
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  } catch {
    return null;
  }
}

/** How the worktree's branch differs from the one previewed, or `null` when it doesn't. */
function describeBranchSwitch(current: string | null, review: { branch: string }): string | null {
  if (current === review.branch) return null;
  return current === null
    ? `this worktree is on a detached HEAD, not '${review.branch}'`
    : `this worktree switched from '${review.branch}' to '${current}'`;
}

/**
 * Refuse the pull if the worktree is on another branch than its confirm showed
 * (#17188).
 *
 * The confirm listed the commits a rebase of THIS branch would replay, and an
 * agent switching branches while it sat open makes that a different operation.
 * Running it anyway is the "if X changed, use Y" substitution the
 * destructive-action rules forbid. Checked before anything resolves the
 * upstream, so a switch to a detached HEAD or an untracked branch is reported
 * as the switch it is rather than as a missing upstream.
 */
function requirePreviewedBranch(
  current: string | null,
  review: GitPullRebaseReview,
  cwd: string
): void {
  const detail = describeBranchSwitch(current, review);
  if (detail) throw pullRebaseReviewStaleError(cwd, current ?? "HEAD", detail);
}

/**
 * Refuse the pull if the worktree moved since its confirm was shown (#17188).
 * Read last before the pull, so the comparison is against the freshest state
 * this handler can see.
 *
 * The branch is read again alongside the commit, not trusted from the check
 * at the start: a checkout of another branch on the SAME commit during the
 * reads in between passes every commit comparison, and would pull this
 * branch's upstream into a branch nobody previewed. Nothing here locks the
 * worktree, so a process acting after this read can still move it.
 */
async function requirePreviewedHead(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  review: GitPullRebaseReview,
  cwd: string
): Promise<void> {
  const current = await readHeadBranch(git);
  requirePreviewedBranch(current, review, cwd);
  const tip = await readOid(git, "HEAD");
  if (tip?.toLowerCase() === review.headOid) return;
  throw pullRebaseReviewStaleError(
    cwd,
    review.branch,
    tip
      ? `'${review.branch}' moved to a different commit`
      : `'${review.branch}' no longer resolves to a commit`
  );
}

function pushReviewStaleError(cwd: string, branchName: string, detail: string): GitOperationError {
  const message = `The branch changed since this push was reviewed: ${detail}. Nothing was pushed. Review the push again to see what it would publish now.`;
  return new GitOperationError(
    "push-review-stale",
    encodeGitOperationErrorMessage("push-review-stale", message, { branchName }),
    { cwd, op: "push", rawMessage: message, branchName }
  );
}

/**
 * Record `destination` as `branchName`'s upstream, the way `git push
 * --set-upstream` would have.
 *
 * Needed because a push whose source is a commit gets no upstream from git:
 * `--set-upstream` only installs tracking for a local branch source. So this
 * writes what git's own installer writes — the remote, the merge ref replacing
 * any earlier one (a repair must overwrite, not add), and `rebase=true` where
 * `branch.autoSetupRebase` asks for it on remote-tracking branches.
 */
async function installPushUpstream(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  branchName: string,
  destination: ResolvedGitPushDestination
): Promise<void> {
  const key = `branch.${branchName}`;
  await git.raw(["config", `${key}.remote`, destination.remote]);
  await git.raw(["config", "--replace-all", `${key}.merge`, `refs/heads/${destination.branch}`]);
  let autoSetupRebase = "";
  try {
    autoSetupRebase = (await git.raw(["config", "--get", "branch.autoSetupRebase"])).trim();
  } catch {
    // Unset: git's default is `never`.
  }
  if (autoSetupRebase === "remote" || autoSetupRebase === "always") {
    await git.raw(["config", `${key}.rebase`, "true"]);
  }
}

/**
 * Does `ref` name a commit that exists in this repository right now?
 *
 * `rev-parse --verify --quiet` exits non-zero without writing to stderr when it
 * does not, which simple-git surfaces as a rejection — so absence arrives here
 * as a throw, not as an empty string. `^{commit}` peels an annotated tag rather
 * than reporting the tag object as a usable range endpoint.
 */
async function refExists(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  ref: string
): Promise<boolean> {
  try {
    const out = await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The commits a remote operation would actually act on — publish, or replay.
 *
 * Both confirms used to preview `git log HEAD`, the branch's recent history,
 * which is only the same set when nothing on the branch has ever been pushed. A
 * branch level with its remote previewed commits that were already published, and
 * a branch 2 ahead of 14 previewed 12 that mostly were. For safeguards whose
 * whole job is "a preview of the ACTUAL content", that is the wrong set — the
 * push side was corrected in #11979 and the rebase side in #11980.
 *
 * Both range from a remote-tracking ref up to the named local branch, and differ
 * only in which ref that is: the PUSH DESTINATION for a publish, the UPSTREAM for
 * a replay. Those are the same ref in the ordinary case and genuinely different in
 * a triangular workflow. The branch is named explicitly rather than read as
 * `HEAD`, because the two diverge the moment anything checks out another branch
 * between opening the dialog and confirming it.
 *
 * Both fail CLOSED on an unresolvable ref, via the same `requireRemoteTarget`
 * every remote-mutating path uses: returning an empty list would read as "nothing
 * to do", which is the reassuring answer and the wrong one (#11746).
 */
const gitRemotePreviewNamespace = defineIpcNamespace({
  name: "gitRemotePreview",
  ops: {
    listPushCommits: op(
      CHANNELS.GIT_LIST_PUSH_COMMITS,
      async (payload: {
        cwd: string;
        branchName: string;
        limit?: number;
        /** Also read what is staged on the previewed tip (Commit & push, #17563). */
        includeStaged?: boolean;
      }): Promise<GitPushCommitPreview> => {
        checkRateLimit(CHANNELS.GIT_LIST_PUSH_COMMITS, 10, 10_000);
        validateCwd(payload?.cwd);
        if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
          throw new Error("Invalid branch name");
        }
        const branchName = payload.branchName.trim();
        const limit = Math.max(1, Math.min(100, payload.limit ?? 20));

        const git = await createHardenedGit(payload.cwd);
        try {
          const destination = await requireRemoteTarget(
            git,
            branchName,
            payload.cwd,
            "list-push-commits"
          );

          // Every ref is written out in full so a branch named like a flag cannot
          // reach argv as one: `refs/heads/` and `refs/remotes/` prefixes make a
          // leading `-` impossible. The remote name is already argv-guarded by
          // `isSafeRemoteName` inside the resolver.
          //
          // The branch is read ONCE, to a commit, and every range below runs
          // from that commit rather than from the ref. The commit is what an
          // approval of this preview pins the push to (#15646), so the rows and
          // the pin have to describe the same tip: a commit landing between two
          // of these reads would otherwise be counted but not pinned.
          const headOid = await readOid(git, `refs/heads/${branchName}`);
          if (!headOid) {
            const message = `Branch '${branchName}' does not resolve to a commit, so there is nothing to preview.`;
            throw new GitOperationError(
              "pathspec-invalid",
              encodeGitOperationErrorMessage("pathspec-invalid", message, { branchName }),
              { cwd: payload.cwd, op: "list-push-commits", rawMessage: message, branchName }
            );
          }
          // Against the same tip the rows are, and before any network read, so
          // the commit is held to the index as it stood when the confirm opened.
          // The index is the worktree's, so it only describes a commit on this
          // branch while the worktree has it checked out: diffed against
          // another branch's tip it would list that branch's differences as
          // staged.
          let staged: GitPushCommitPreview["staged"];
          if (payload.includeStaged === true) {
            const switched = describeBranchSwitch(await readHeadBranch(git), {
              branch: branchName,
            });
            if (switched) {
              throw commitReviewStaleError(payload.cwd, branchName, switched, "list-push-commits");
            }
            staged = await readStagedSnapshot(payload.cwd, headOid);
          }
          const hasRemoteRef = await refExists(git, destination.remoteTrackingRef);

          // With no remote-tracking ref there is nothing to subtract locally, and
          // `<missing>..<branch>` is a fatal argument rather than "everything".
          //
          // Ask the remote before guessing. A missing tracking ref does not mean
          // a missing branch — it also happens when the branch was never
          // fetched, was pruned, or is excluded by the fetch refspec — and the
          // purely local fallback is wrong in BOTH directions: it overstates when
          // the destination exists but is unfetched, and understates a commit
          // that sits on another ref of the same remote yet not on the
          // destination branch, which this push would add.
          let rangeBasis: GitPushCommitPreview["rangeBasis"];
          let revArgs: string[];
          // The destination tip the range was measured from, when there is one.
          // The same tip decides `behind`, so the two can never describe
          // different states of the remote.
          let destinationTip: string | null = null;
          if (hasRemoteRef) {
            rangeBasis = "tracked";
            destinationTip = destination.remoteTrackingRef;
            revArgs = [`${destination.remoteTrackingRef}..${headOid}`];
          } else {
            const remoteTip = await readRemoteBranchTip(
              git,
              destination.remote,
              destination.branch
            );
            if (remoteTip === null) {
              // The remote answered and has no such branch: the push creates it,
              // and what it publishes is the branch's own history.
              rangeBasis = "creates";
              revArgs = [headOid];
            } else if (remoteTip && (await refExists(git, remoteTip))) {
              // The remote named a tip this repository already holds, so the
              // delta is exact even without a tracking ref.
              rangeBasis = "tracked";
              destinationTip = remoteTip;
              revArgs = [`${remoteTip}..${headOid}`];
            } else {
              // No answer, or a tip we cannot resolve. Fall back to the local
              // approximation and mark it as what it is.
              rangeBasis = "unverified";
              revArgs = [headOid, "--not", `--remotes=${destination.remote}`];
            }
          }

          // No `--no-merges`: the "N more" tail is only honest while the listed
          // rows and `total` describe the same set the push would write.
          const log = await git.log([`--max-count=${limit}`, ...revArgs]);
          const total = await countCommitsInRange(git, revArgs);
          // Measured in the other direction: a destination holding commits the
          // branch lacks refuses the push as non-fast-forward, and the approver
          // should see that before approving rather than after.
          const behind =
            destinationTip === null
              ? 0
              : await countCommitsInRange(git, [`${headOid}..${destinationTip}`]);

          return {
            destination: { remote: destination.remote, branch: destination.branch },
            rangeBasis,
            total,
            behind,
            headOid,
            commits: log.all.map((commit) => ({
              hash: commit.hash,
              date: commit.date,
              message: commit.message,
              author: commit.author_name,
            })),
            ...(staged ? { staged } : {}),
          };
        } catch (error) {
          if (error instanceof GitOperationError) throw error;
          const errorMessage = formatErrorMessage(error, "git log failed");
          const gitReason = classifyGitFailure(error, errorMessage);
          throw new GitOperationError(
            gitReason,
            encodeGitOperationErrorMessage(gitReason, errorMessage, { branchName }),
            {
              cwd: payload.cwd,
              op: "list-push-commits",
              cause: error instanceof Error ? error : undefined,
              rawMessage: errorMessage,
              branchName,
            }
          );
        }
      }
    ),

    listRebaseCommits: op(
      CHANNELS.GIT_LIST_REBASE_COMMITS,
      async (payload: {
        cwd: string;
        branchName: string;
        limit?: number;
      }): Promise<GitRebaseCommitPreview> => {
        checkRateLimit(CHANNELS.GIT_LIST_REBASE_COMMITS, 10, 10_000);
        validateCwd(payload?.cwd);
        if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
          throw new Error("Invalid branch name");
        }
        const branchName = payload.branchName.trim();
        const limit = Math.max(1, Math.min(100, payload.limit ?? 20));

        const git = await createHardenedGit(payload.cwd);
        try {
          // `"upstream"`, not the push target: `git pull --rebase` integrates
          // from what the branch tracks, and in a triangular setup those are
          // different repositories (#11746).
          const upstream = await requireRemoteTarget(
            git,
            branchName,
            payload.cwd,
            "list-rebase-commits",
            "upstream"
          );

          const localRef = `refs/heads/${branchName}`;
          // Read FIRST and measured from, as the push preview does (#17188).
          // This is the commit the pull is held to, so every row below has to
          // describe it: read last, a commit landing mid-measurement would be
          // pinned without ever having been shown. Unreadable, the rows still
          // describe the branch, but there is nothing to approve them under.
          const headOid = await readOid(git, localRef);
          const tip = headOid ?? localRef;

          // Deliberately no `ls-remote` fallback, unlike the push preview.
          // `git pull --rebase` fetches before it replays, and a rebase onto a
          // MOVED upstream still replays this same set — anything the upstream
          // absorbed in the meantime is dropped by rebase's own patch-id
          // detection rather than added to the range. So the last-known tip is
          // the correct base to measure against and no network read can improve
          // the answer, which keeps a confirm dialog off the network entirely.
          if (!(await refExists(git, upstream.remoteTrackingRef))) {
            // Configured but never fetched here. `<missing>..<branch>` is a
            // fatal argument, and the branch's own history is NOT the replay
            // set — returning it is the exact misreport this preview exists to
            // stop. Say the range is unmeasured instead.
            return {
              upstream: { remote: upstream.remote, branch: upstream.branch },
              rangeBasis: "unfetched",
              commits: [],
              total: 0,
              behind: 0,
              incoming: [],
              headOid,
            };
          }

          // `git rebase`'s own selection, not a plain two-dot range. Rebase
          // picks its todo list with `--no-merges --cherry-pick --right-only`
          // over the symmetric difference, and each flag drops rows a two-dot
          // range would have promised to rewrite:
          //
          //  - `--no-merges`, because a default rebase does not recreate merge
          //    commits. Listing them claims a rewrite that never happens.
          //    (The push preview deliberately keeps merges — a push publishes
          //    them — which is why this is not shared with it.)
          //  - `--cherry-pick --right-only` over `...`, because a commit the
          //    upstream already carries as an equivalent patch is skipped by
          //    rebase rather than replayed. Those are exactly the commits a
          //    developer arriving from a rejected push is most likely to have.
          const revArgs = [
            "--no-merges",
            "--cherry-pick",
            "--right-only",
            `${upstream.remoteTrackingRef}...${tip}`,
          ];
          const log = await git.log([`--max-count=${limit}`, ...revArgs]);
          const total = await countCommitsInRange(git, revArgs);
          // Measured separately and in the other direction: an empty replay set
          // is produced both by a branch level with its upstream and by one
          // purely behind it, and only the second is moved by the rebase.
          const incomingRange = `${tip}..${upstream.remoteTrackingRef}`;
          const behind = await countCommitsInRange(git, [incomingRange]);
          const incomingLog =
            behind > 0 ? await git.log([`--max-count=${limit}`, incomingRange]) : null;

          return {
            upstream: { remote: upstream.remote, branch: upstream.branch },
            rangeBasis: "tracked",
            headOid,
            total,
            behind,
            commits: log.all.map((commit) => ({
              hash: commit.hash,
              date: commit.date,
              message: commit.message,
              author: commit.author_name,
            })),
            incoming: (incomingLog?.all ?? []).map((commit) => ({
              hash: commit.hash,
              date: commit.date,
              message: commit.message,
              author: commit.author_name,
            })),
          };
        } catch (error) {
          if (error instanceof GitOperationError) throw error;
          const errorMessage = formatErrorMessage(error, "git log failed");
          const gitReason = classifyGitFailure(error, errorMessage);
          throw new GitOperationError(
            gitReason,
            encodeGitOperationErrorMessage(gitReason, errorMessage, { branchName }),
            {
              cwd: payload.cwd,
              op: "list-rebase-commits",
              cause: error instanceof Error ? error : undefined,
              rawMessage: errorMessage,
              branchName,
            }
          );
        }
      }
    ),
  },
});

/**
 * Base-branch names arrive from the renderer's worktree snapshot, not from a
 * user text field — but they still reach argv, so they are validated with the
 * same suspicion as any other write input. `git check-ref-format` rules are not
 * restated here: the branch is only ever spelled as a fully-qualified
 * `refs/heads/…` or `refs/remotes/…` ref downstream, which makes a leading `-`
 * unrepresentable. What is rejected is what would break that guarantee.
 */
function requireBaseBranch(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid base branch");
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{/.test(trimmed)) {
    throw new Error("Invalid base branch");
  }
  // `@` and `HEAD` are legal branch names AND git revision shorthands, and the
  // shorthand wins wherever a revision is expected. `@` is the sharp one: it is
  // shorthand for HEAD, so a base named `@` turns any `<base>@{upstream}` read
  // into "the CURRENT branch's upstream" — "rebase onto @" would then target
  // the feature branch's own upstream. Refusing both is cheaper than auditing
  // every downstream read for revision-vs-ref context.
  if (trimmed === "@" || trimmed === "HEAD") throw new Error("Invalid base branch");
  return trimmed;
}

/**
 * The branch the operation acts on, refused on a detached HEAD.
 *
 * A detached worktree has no branch to rewrite or extend, and rebasing one
 * produces commits reachable from nothing once HEAD moves again.
 */
async function requireCheckedOutBranch(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "revparse">
): Promise<string> {
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    // A plain Error, deliberately: no `GitOperationReason` describes a detached
    // HEAD, and the nearest bucket (`config-missing`) carries a hint telling
    // the user to set an upstream — which would not fix this and is not what
    // they did wrong. The sentence below is the whole diagnosis.
    throw new Error(
      "This worktree has no branch checked out, so there is nothing to integrate the base branch into."
    );
  }
  return branch;
}

/**
 * Resolve the base ref, or refuse the operation (#12092).
 *
 * The twin of `requireRemoteTarget` and fail-closed for the same reason: a base
 * ref nobody can name must never degrade into `origin/<base>` on faith. Here
 * the stakes are a local history rewrite rather than a wrong-repo push, but the
 * failure mode is the same shape — an operation that reports success against a
 * target the user never sanctioned.
 */
async function requireBaseTarget(
  git: Parameters<typeof resolveExistingBaseCompareTarget>[0],
  baseBranch: string,
  cwd: string
): Promise<ExistingBaseCompareTarget> {
  const target = await resolveExistingBaseCompareTarget(git, baseBranch);
  if (target) return target;
  // Worded to land in the existing `config-missing` bucket, which already
  // carries a recovery hint, rather than inventing a reason for one call site.
  const message = `Could not resolve a ref for base branch '${baseBranch}'. No remote carries it and there is no local branch of that name — fetch the remote or check out the base branch once.`;
  throw new GitOperationError(
    "config-missing",
    encodeGitOperationErrorMessage("config-missing", message),
    { cwd, op: "base-integration", rawMessage: message }
  );
}

/**
 * What `git status` holds that a base integration refuses to start over, or
 * `null` when the tree is clean. The single predicate behind both the write's
 * refusal and the preview's blocker, so the two cannot drift apart.
 *
 * `isClean()` can be true while unmerged paths stand, so the conflicted list is
 * checked on its own rather than trusted to fold into it. Conflicts come first:
 * "commit or stash" can't be followed until they are resolved. Every other
 * entry is counted once, untracked included, rather than summing staged and
 * unstaged rows that can both name one path.
 */
async function readTreeBlocker(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "status">
): Promise<Extract<
  GitBaseIntegrationBlocker,
  { reason: "conflicts" | "uncommitted-changes" }
> | null> {
  const status = await git.status();
  if (status.conflicted.length > 0) {
    return { reason: "conflicts", count: status.conflicted.length };
  }
  if (status.isClean()) return null;
  return { reason: "uncommitted-changes", count: status.files.length };
}

/**
 * Refuse to start on a tree that has anything in it.
 *
 * git would refuse most of this on its own, but not all of it and not legibly:
 * `git merge` happily proceeds over untracked files right up until one collides
 * with an incoming path, and the raw refusals it does emit ("error: cannot
 * rebase: You have unstaged changes.") are classified after the fact from a
 * message. Checking first turns every one of those into the same up-front,
 * already-classified answer, and — the part that matters — guarantees nothing
 * has been rewritten by the time the user sees it.
 *
 * Untracked files count. A merge that would write over one fails partway
 * through with the worktree already modified, which is precisely the halt this
 * operation is supposed to make recoverable rather than cause.
 */
async function requireCleanTree(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "status">,
  cwd: string,
  op: string
): Promise<void> {
  if ((await readTreeBlocker(git)) === null) return;
  const message =
    "This worktree has uncommitted changes. Commit or stash them before integrating the base branch.";
  throw new GitOperationError(
    "worktree-dirty",
    encodeGitOperationErrorMessage("worktree-dirty", message),
    { cwd, op, rawMessage: message }
  );
}

/**
 * Refuse a pull-rebase over uncommitted changes to tracked files — the ones git
 * itself refuses to rebase over. Untracked files don't block a rebase, so unlike
 * {@link requireCleanTree} they are not counted here.
 */
async function requireNoTrackedChanges(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "status">,
  cwd: string,
  op: string
): Promise<void> {
  const status = await git.status();
  const tracked = status.files.filter((f) => !(f.index === "?" && f.working_dir === "?"));
  if (tracked.length === 0) return;
  const message =
    "This worktree has uncommitted changes to tracked files. Commit or stash them before pulling.";
  throw new GitOperationError(
    "worktree-dirty",
    encodeGitOperationErrorMessage("worktree-dirty", message),
    { cwd, op, rawMessage: message }
  );
}

/**
 * The merge, rebase, cherry-pick, revert or `git am` halted in this worktree, or `null`
 * when none is. Read from the git dir's sentinels, which is what the write
 * refuses on and what the preview reports, so the two agree.
 */
async function readHaltedOperation(
  git: Awaited<ReturnType<typeof createHardenedGit>>,
  cwd: string
): Promise<Extract<GitBaseIntegrationBlocker, { reason: "operation-in-progress" }> | null> {
  const gitDir = await resolveGitDir(git, cwd);
  const detected = await detectRepoOperationState(gitDir, false);
  if (detected.state === "CLEAN" || detected.state === "DIRTY") return null;
  return {
    reason: "operation-in-progress",
    operation: detected.state,
    rebaseStep: detected.rebaseStep ?? null,
    rebaseTotalSteps: detected.rebaseTotalSteps ?? null,
  };
}

const HALTED_OPERATION_NAME: Record<
  Extract<GitBaseIntegrationBlocker, { reason: "operation-in-progress" }>["operation"],
  string
> = {
  MERGING: "merging",
  REBASING: "rebasing",
  CHERRY_PICKING: "cherry-picking",
  REVERTING: "reverting",
  APPLYING_MAILBOX: "applying patches with git am",
};

/**
 * Refuse to start a second operation on top of a halted one.
 *
 * Starting a rebase mid-rebase is refused by git anyway, but the message is
 * about `.git/rebase-merge` rather than about what the user should do — and the
 * recovery they need (Abort or Continue) is one menu row away. Saying so
 * directly is the difference between a dead end and a next step.
 */
async function requireNoOperationInProgress(
  git: Awaited<ReturnType<typeof createHardenedGit>>,
  cwd: string,
  op: string
): Promise<void> {
  const halted = await readHaltedOperation(git, cwd);
  if (!halted) return;
  const message = `This worktree is already mid-operation (${HALTED_OPERATION_NAME[halted.operation]}). Continue or abort it before starting another.`;
  throw new GitOperationError(
    "conflict-unresolved",
    encodeGitOperationErrorMessage("conflict-unresolved", message),
    { cwd, op, rawMessage: message }
  );
}

/** A base-integration preview whose branch or base tip no longer names a commit. */
function basePreviewUnresolvedError(
  message: string,
  cwd: string,
  branchName: string
): GitOperationError {
  return new GitOperationError(
    "pathspec-invalid",
    encodeGitOperationErrorMessage("pathspec-invalid", message, { branchName }),
    { cwd, op: "list-base-integration-commits", rawMessage: message, branchName }
  );
}

const OPERATION_NOUN: Record<RepoOperationPin["operation"], string> = {
  MERGING: "merge",
  REBASING: "rebase",
  CHERRY_PICKING: "cherry-pick",
  REVERTING: "revert",
  APPLYING_MAILBOX: "patch apply",
};

function asHaltedOperation(state: RepoState): RepoOperationPin["operation"] | null {
  return state === "CLEAN" || state === "DIRTY" ? null : state;
}

/**
 * The pin an abort or continue arrived with, checked for shape. `undefined`
 * only when none was sent; a malformed one is refused rather than read as
 * none, which would quietly drop the check it was sent to make.
 */
function readRepoOperationPin(value: unknown): RepoOperationPin | undefined {
  if (value === undefined) return undefined;
  const pin = value as { operation?: unknown; operationId?: unknown } | null;
  const operation = pin?.operation;
  const operationId = pin?.operationId;
  if (
    typeof operation !== "string" ||
    !Object.hasOwn(OPERATION_NOUN, operation) ||
    !(operationId === null || (typeof operationId === "string" && operationId.length > 0))
  ) {
    throw new Error("Invalid repository operation pin");
  }
  return { operation: operation as RepoOperationPin["operation"], operationId };
}

/**
 * Refuse an abort or continue unless the operation it was chosen for is the
 * one in progress now (#17559).
 *
 * Without this the handler acted on whatever it found at execution time. A
 * confirm left open while another client ended the merge and started another
 * (or the same one again) would abort the new one, conflict work and all,
 * under an approval given for the old. The kind is not enough: a same-kind
 * replacement is exactly that case. So the pin carries the operation's
 * identity, read from the status the user was shown, and the identity is read
 * again here, as the last thing before git runs. Git's own `--abort` and
 * `--continue` take no instance to check against, so a client acting after
 * this read can still slip in; the window is this handler's, not the dialog's.
 *
 * A caller that sends no pin had nothing on screen to bind to (an agent
 * dispatch) and keeps acting on what it finds.
 */
async function requireChosenRepoOperation(
  gitDir: string,
  state: RepoState,
  pin: RepoOperationPin | undefined,
  cwd: string,
  op: "abort" | "continue"
): Promise<void> {
  if (pin === undefined) return;
  const current = asHaltedOperation(state);
  const currentId = current ? await readRepoOperationId(gitDir, current) : null;
  if (current === pin.operation && pin.operationId !== null && currentId === pin.operationId) {
    return;
  }
  const chosen = OPERATION_NOUN[pin.operation];
  const detail =
    current === null
      ? `The ${chosen} you chose is no longer in progress`
      : current !== pin.operation
        ? `A ${OPERATION_NOUN[current]} is in progress now, not the ${chosen} you chose`
        : pin.operationId === null || currentId === null
          ? `Daintree couldn't confirm that the ${chosen} in progress is the one you chose`
          : `The ${chosen} in progress was restarted or replaced after you chose it`;
  const message = `${detail}. Nothing was ${op === "abort" ? "aborted" : "continued"}; check the worktree's current state and choose again.`;
  // Plain prose: the preload encodes the transport prefix from the reason, so
  // encoding it here as well would show the user the second copy.
  throw new GitOperationError("repo-operation-changed", message, {
    cwd,
    op: `${op}-repository-operation`,
    rawMessage: message,
  });
}

/** Classify anything a base-integration read or write throws, once. */
function asBaseIntegrationError(error: unknown, cwd: string, op: string): unknown {
  // An already-classified, already-encoded refusal — re-wrapping would
  // double-encode its message.
  if (error instanceof GitOperationError) return error;
  const errorMessage = formatErrorMessage(error, `git ${op} failed`);
  const gitReason = classifyGitFailure(error, errorMessage);
  return new GitOperationError(gitReason, encodeGitOperationErrorMessage(gitReason, errorMessage), {
    cwd,
    op,
    cause: error instanceof Error ? error : undefined,
    rawMessage: errorMessage,
  });
}

/**
 * The commit a Commit & push confirm reviewed, or `null` when the payload
 * pins nothing (#17563).
 *
 * All three or none, for the reason push takes all four: a pin that kept the
 * commit but lost the staged identity reads as "reviewed" while committing
 * whatever the index holds by then.
 */
function readCommitReview(payload: {
  expectedBranch?: unknown;
  expectedHeadOid?: unknown;
  expectedStagedIdentity?: unknown;
}): GitCommitReview | null {
  const {
    expectedBranch: branch,
    expectedHeadOid: headOid,
    expectedStagedIdentity: stagedIdentity,
  } = payload;
  if (branch === undefined && headOid === undefined && stagedIdentity === undefined) return null;
  if (
    typeof branch !== "string" ||
    !branch ||
    typeof headOid !== "string" ||
    !FULL_OID_PATTERN.test(headOid) ||
    typeof stagedIdentity !== "string" ||
    !/^[0-9a-f]{64}$/.test(stagedIdentity)
  ) {
    throw new AppError({ code: "VALIDATION", message: "Invalid commit review" });
  }
  return { branch, headOid: headOid.toLowerCase(), stagedIdentity };
}

/**
 * Plain prose, not pre-encoded like its siblings: the composer shows this
 * sentence as is, and the reason and branch already cross to the renderer as
 * fields the preload encodes once. Encoding here too left a second prefix in
 * front of the sentence on screen.
 */
function commitReviewStaleError(
  cwd: string,
  branchName: string,
  detail: string,
  op = "commit"
): GitOperationError {
  const message =
    op === "commit"
      ? `This commit changed after it was reviewed: ${detail}. Nothing was committed or pushed. Commit and push again to review what is staged now.`
      : `${detail}, so what is staged there can't be reviewed for '${branchName}'.`;
  return new GitOperationError("commit-review-stale", message, {
    cwd,
    op,
    rawMessage: message,
    branchName,
  });
}

/**
 * Refuse the commit unless the worktree is still on the reviewed branch, at
 * the reviewed commit, with exactly the reviewed changes staged (#17563).
 *
 * The confirm listed these staged files, and an agent can restage any of them
 * while it sits open without changing a single name in the list. Committing
 * whatever the index holds now is the "if X changed, use Y" substitution the
 * destructive-action rules forbid. Read last before `git commit`; nothing locks
 * the index in between, so the caller also checks what the commit contains.
 */
async function requireReviewedStage(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  review: GitCommitReview,
  cwd: string
): Promise<void> {
  const current = await readHeadBranch(git);
  const switched = describeBranchSwitch(current, review);
  if (switched) throw commitReviewStaleError(cwd, current ?? "HEAD", switched);
  const tip = await readOid(git, "HEAD");
  if (tip?.toLowerCase() !== review.headOid) {
    throw commitReviewStaleError(
      cwd,
      review.branch,
      tip
        ? `'${review.branch}' moved to a different commit`
        : `'${review.branch}' no longer resolves to a commit`
    );
  }
  const staged = await readStagedSnapshot(cwd, review.headOid);
  if (staged.identity !== review.stagedIdentity) {
    throw commitReviewStaleError(cwd, review.branch, "the staged changes are different");
  }
}

/**
 * Resolve a ref to its commit OID, or `null` when it does not resolve.
 *
 * Shared by the preview (which records the OIDs it measured against) and the
 * write (which checks they still hold), so the two cannot read the ref two
 * different ways.
 */
async function readOid(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  fullRef: string
): Promise<string | null> {
  try {
    const out = await git.raw(["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`]);
    const oid = out.trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

/**
 * The full OID and parents of the commit `git commit` just reported.
 *
 * Read from the hash git printed, never from `HEAD`: an agent commit landing
 * right after this one would move `HEAD`, and a push pinned to that would
 * publish a commit nobody approved. git prints a prefix unique when it was
 * printed, so it names exactly this commit; on any failure to read it back
 * there is nothing to pin to, and the caller is told so rather than handed a
 * guess. A detached `HEAD` prints `HEAD <hash>`, so only the last word counts.
 */
async function readCommitted(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  printedHash: string
): Promise<Pick<GitCommitResult, "oid" | "parentOids">> {
  const unread = { oid: null, parentOids: [] };
  const abbrev = printedHash.trim().split(/\s+/).pop() ?? "";
  if (!/^[0-9a-f]{4,64}$/i.test(abbrev)) return unread;
  try {
    const out = await git.raw(["rev-list", "--parents", "--max-count=1", `${abbrev}^{commit}`]);
    const oids = out.trim().split(/\s+/);
    // Every word an OID, or none trusted: a parent list read short would let a
    // merge commit pass for one made on top of the reviewed tip alone.
    if (!oids[0] || !oids.every((oid) => FULL_OID_PATTERN.test(oid))) return unread;
    const [oid, ...parentOids] = oids.map((o) => o.toLowerCase());
    return { oid, parentOids };
  } catch {
    return unread;
  }
}

/**
 * What a reviewed commit contains over its one parent, or `null` when it has
 * no single parent to compare with or couldn't be read. A reviewed commit is
 * always made on the reviewed tip, so anything else matches no review.
 */
async function readCommittedStagedIdentity(
  cwd: string,
  committed: Pick<GitCommitResult, "oid" | "parentOids">
): Promise<string | null> {
  const [parent, ...rest] = committed.parentOids;
  if (!committed.oid || !parent || rest.length > 0) return null;
  try {
    return await readCommitStagedIdentity(cwd, parent, committed.oid);
  } catch {
    return null;
  }
}

/**
 * Refuse the write if anything moved between the preview and the approval.
 *
 * The confirm dialog is a promise about specific commits: *these* get replayed,
 * *onto that*. In this product that promise has a genuinely short shelf life —
 * Daintree exists to run many agents in parallel across worktrees, so an agent
 * committing into the worktree while the dialog sits open is the ordinary case
 * rather than a race to shrug at. Background fetch moving the remote-tracking
 * ref is the same story from the other end.
 *
 * So the preview reports the two OIDs it measured against and the write checks
 * them. A mismatch is refused rather than reconciled: re-previewing silently
 * would be the "if X changed, use Y" substitution the destructive-action rules
 * call a review blocker, and the operation the user actually sanctioned no
 * longer exists.
 *
 * Both are OPTIONAL. A caller that supplies neither — an agent dispatch, a
 * keybinding, a plugin — gets today's unpinned behaviour rather than a hard
 * failure, because there was no preview to bind to in the first place. What
 * must never happen is a supplied expectation being ignored.
 */
async function requireUnmovedSince(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  payload: {
    expectedBranch?: string;
    expectedHeadOid?: string;
    expectedBaseOid?: string;
    cwd: string;
  },
  branch: string,
  target: ExistingBaseCompareTarget,
  op: string
): Promise<void> {
  // The branch NAME, not only its tip. Pinning the OID alone leaves a hole:
  // checking out a different branch that happens to sit on the same commit
  // passes every OID check while the operation goes on to rewrite a branch the
  // user never saw named.
  if (payload.expectedBranch && payload.expectedBranch !== branch) {
    const message = `This worktree is now on '${branch}' rather than '${payload.expectedBranch}', so this operation would act on a different branch than the one previewed. Try again to see the current state.`;
    throw new GitOperationError(
      "conflict-unresolved",
      encodeGitOperationErrorMessage("conflict-unresolved", message, { branchName: branch }),
      { cwd: payload.cwd, op, rawMessage: message, branchName: branch }
    );
  }

  const checks: Array<{ expected: string | undefined; ref: string; what: string }> = [
    { expected: payload.expectedHeadOid, ref: "HEAD", what: "This branch has new commits" },
    {
      expected: payload.expectedBaseOid,
      ref: target.fullRef,
      what: `${target.compareRef} has moved`,
    },
  ];

  for (const { expected, ref, what } of checks) {
    if (!expected) continue;
    const actual = await readOid(git, ref);
    if (actual === expected) continue;
    const message = `${what} since this operation was previewed, so it would no longer do what was approved. Try again to see the current state.`;
    throw new GitOperationError(
      "conflict-unresolved",
      encodeGitOperationErrorMessage("conflict-unresolved", message),
      { cwd: payload.cwd, op, rawMessage: message }
    );
  }
}

/**
 * Worktrees with a base integration in flight.
 *
 * A second start against the same worktree while the first is still running
 * would race the sentinel check above — `requireNoOperationInProgress` reads
 * `.git/` state that the in-flight operation has not written yet. Mirrors the
 * `pushingCwds` guard the push path already uses.
 */
const baseIntegratingCwds = new Set<string>();

/**
 * Refuse while this worktree already has a base integration running. The
 * preview asks too: until git writes its first sentinel, a running integration
 * leaves the tree looking clean and level, and the preview would measure an
 * approval the write is certain to refuse.
 */
function requireNoBaseIntegrationRunning(cwd: string, op: string): void {
  if (!baseIntegratingCwds.has(cwd)) return;
  const message = "A base-branch integration is already running in this worktree.";
  throw new GitOperationError(
    "conflict-unresolved",
    encodeGitOperationErrorMessage("conflict-unresolved", message),
    { cwd, op, rawMessage: message }
  );
}

/**
 * Run a base integration end to end: preflight, then exactly one git command.
 *
 * A halt is NOT an error to clean up. `git rebase` stopping on a conflict
 * leaves the worktree mid-rebase on purpose, and `repoState` flipping to
 * `REBASING` is what routes the user to Review Hub's ConflictPanel, where Abort
 * and Continue live. Auto-aborting here would delete the conflict the user is
 * about to resolve and report a plain failure instead — so the error is
 * classified and rethrown with the operation left exactly where git left it.
 */
async function runBaseIntegration(
  payload: {
    cwd: string;
    baseBranch: string;
    expectedBranch?: string;
    expectedHeadOid?: string;
    expectedBaseOid?: string;
  },
  kind: GitBaseIntegrationKind
): Promise<void> {
  validateCwd(payload?.cwd);
  const baseBranch = requireBaseBranch(payload?.baseBranch);
  const op = kind === "rebase-onto-base" ? "rebase-onto-base" : "merge-base";

  requireNoBaseIntegrationRunning(payload.cwd, op);
  // Claimed INSIDE the try, so the `finally` that releases it dominates every
  // path that could have claimed it. Adding before `createHardenedGit` left the
  // cwd marked forever if that factory rejected — a deleted worktree would then
  // report "already running" until the main process restarted.
  baseIntegratingCwds.add(payload.cwd);
  try {
    const git = await createHardenedGit(payload.cwd);
    // First, because a halted rebase detaches HEAD: checked after the branch,
    // it was refused as "no branch checked out", which names the wrong fix.
    await requireNoOperationInProgress(git, payload.cwd, op);
    const branch = await requireCheckedOutBranch(git);
    // THE invariant, enforced rather than assumed. Everything else in this file
    // arranges for the operation to read the base ref and write only this
    // worktree's HEAD — but if HEAD *is* the base branch, "write only HEAD"
    // and "write refs/heads/<base>" are the same sentence. Possible whenever a
    // worktree has the base checked out: a fork layout where the feature branch
    // is also called `develop`, or a hand-arranged tree.
    if (branch === baseBranch) {
      const message = `This worktree has '${baseBranch}' itself checked out, so integrating the base branch would rewrite it. Check out the branch you want to update first.`;
      throw new GitOperationError(
        "config-missing",
        encodeGitOperationErrorMessage("config-missing", message, { branchName: branch }),
        { cwd: payload.cwd, op, rawMessage: message, branchName: branch }
      );
    }
    await requireCleanTree(git, payload.cwd, op);
    const target = await requireBaseTarget(git, baseBranch, payload.cwd);
    await requireUnmovedSince(git, payload, branch, target, op);

    // `-c` overrides rather than command-line flags, deliberately. Git ignores a
    // config key it does not know, so these degrade to a no-op on an older git;
    // the equivalent `--no-update-refs` / `--no-rebase-merges` flags are hard
    // errors there instead. Each pin closes a gap between what the confirm
    // dialog described and what git would actually do under a user's config:
    //
    //  - `rebase.updateRefs=true` force-updates OTHER local branches that point
    //    into the replayed range. `refs/heads/<base>` can be one of them, which
    //    is the exact write this whole path exists to avoid.
    //  - `rebase.rebaseMerges=true` recreates merge commits the preview omitted
    //    (it measures with `--no-merges`, matching a default rebase).
    //  - `*.autoStash=true` would stash and re-apply the user's changes, which
    //    contradicts the refusal this handler just performed and can strand
    //    them in a stash-pop conflict on top of the rebase.
    const pins =
      kind === "rebase-onto-base"
        ? [
            "-c",
            "rebase.updateRefs=false",
            "-c",
            "rebase.rebaseMerges=false",
            "-c",
            "rebase.autoStash=false",
          ]
        : ["-c", "merge.autoStash=false"];

    if (kind === "rebase-onto-base") {
      await git.raw([...pins, "rebase", target.fullRef]);
    } else {
      // `--no-edit` is load-bearing, not tidiness: a real (non-fast-forward)
      // merge opens an editor for the commit message, and there is no TTY in a
      // utility process for it to open on. Without this the spawn hangs.
      //
      // `--no-squash` overrides a `branch.<name>.mergeOptions = --squash`, which
      // git applies BEFORE command-line args. Under that config the merge would
      // report success having created no commit and left everything staged —
      // the opposite of what the dialog promised.
      await git.raw([...pins, "merge", "--no-edit", "--no-squash", target.fullRef]);
    }

    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("git-push");
    }
  } catch (error) {
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("git-push-error");
    }
    throw asBaseIntegrationError(error, payload.cwd, op);
  } finally {
    baseIntegratingCwds.delete(payload.cwd);
  }
}

/**
 * Integrating the BASE branch into a worktree (#12092).
 *
 * The distinction from `gitRemotePreviewNamespace` above is the ref, and it is
 * the whole point: those ops act on the branch's own push destination or
 * upstream, which on a never-pushed feature branch does not exist and on a
 * pushed one says nothing about `develop` having moved. These act on the base
 * branch the worktree card already measures itself against.
 *
 * Three rules hold across all of them:
 *
 * 1. **Never write `refs/heads/<base>`.** Daintree's base branch is normally
 *    checked out in the main worktree, and git refuses to update a branch
 *    checked out somewhere else — `git fetch origin develop:develop` fails with
 *    `refuse to fetch into current branch`. Rebasing or merging the
 *    remote-tracking ref DIRECTLY sidesteps that entirely: it reads the ref and
 *    writes only this worktree's own HEAD.
 * 2. **Never fetch.** These operate on whatever the base ref points at right
 *    now. Background fetch is what keeps it fresh (#12091); folding a network
 *    read in here would make a confirm dialog's preview and the operation it
 *    describes measure two different tips.
 * 3. **Refuse a dirty tree rather than autostash.** Matching `handlePullRebase`
 *    and the convention every desktop git client follows: an autostash whose
 *    pop conflicts strands the user in a worse state than the clean upfront
 *    refusal, on top of a halt they now also have to resolve.
 */
const gitBaseIntegrationNamespace = defineIpcNamespace({
  name: "gitBaseIntegration",
  ops: {
    listBaseIntegrationCommits: op(
      CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS,
      async (payload: {
        cwd: string;
        baseBranch: string;
        kind: GitBaseIntegrationKind;
        limit?: number;
      }): Promise<GitBaseIntegrationCommitPreview> => {
        checkRateLimit(CHANNELS.GIT_LIST_BASE_INTEGRATION_COMMITS, 10, 10_000);
        validateCwd(payload?.cwd);
        const baseBranch = requireBaseBranch(payload?.baseBranch);
        const kind = payload?.kind;
        if (kind !== "rebase-onto-base" && kind !== "merge-base") {
          throw new Error("Invalid integration kind");
        }
        const limit = Math.max(1, Math.min(100, payload.limit ?? 20));
        requireNoBaseIntegrationRunning(payload.cwd, "list-base-integration-commits");

        const git = await createHardenedGit(payload.cwd);
        try {
          // The write's own refusals, read in the order that names the right
          // fix (#17189). Without them the confirm offered an approval the
          // write was certain to refuse, and only said so in a toast after it
          // had closed. A halted operation and a checked-out base stop the
          // read: there is no meaningful range to measure from either.
          const unmeasured = {
            kind,
            baseBranch,
            compareRef: null,
            remote: null,
            headOid: null,
            baseOid: null,
            commits: [],
            total: null,
            behind: null,
          };
          // Before the branch: a halted rebase detaches HEAD, and reading the
          // branch first fails as "no branch checked out".
          const halted = await readHaltedOperation(git, payload.cwd);
          if (halted) return { ...unmeasured, branch: null, blocker: halted };

          const branchName = await requireCheckedOutBranch(git);
          if (branchName === baseBranch) {
            return { ...unmeasured, branch: branchName, blocker: { reason: "base-checked-out" } };
          }
          // Measured anyway: what the operation WOULD do is worth seeing while
          // deciding whether to commit first.
          const treeBlocker = await readTreeBlocker(git);

          const target = await requireBaseTarget(git, baseBranch, payload.cwd);

          // Read FIRST and measured from, as the push and pull-rebase previews
          // do (#17188). These two are what the write is held to, so every row
          // and count below has to describe them: read last, a commit landing
          // mid-measurement on either side was pinned without ever having been
          // listed (#17583). Unresolvable, there is nothing to approve the rows
          // under, so the read fails rather than offering an unpinned approval.
          const headOid = await readOid(git, `refs/heads/${branchName}`);
          if (!headOid) {
            throw basePreviewUnresolvedError(
              `Branch '${branchName}' does not resolve to a commit, so there is nothing to preview.`,
              payload.cwd,
              branchName
            );
          }
          const baseOid = await readOid(git, target.fullRef);
          if (!baseOid) {
            throw basePreviewUnresolvedError(
              `Base ref '${target.compareRef}' does not resolve to a commit, so there is nothing to preview.`,
              payload.cwd,
              branchName
            );
          }

          // Rebase and merge describe OPPOSITE ranges, so each gets the range
          // git itself would use rather than one shared approximation.
          //
          // Rebase replays with `--no-merges --cherry-pick --right-only` over
          // the symmetric difference — that is rebase's own todo-list
          // selection, and each flag drops rows a two-dot range would have
          // promised to rewrite (a default rebase recreates no merge commits,
          // and skips commits the base already holds as equivalent patches).
          //
          // Merge brings in `<local>..<base>` and KEEPS merges: a merge commit
          // on the base is genuinely one of the commits that arrives.
          const incomingRange = `${headOid}..${baseOid}`;
          const revArgs =
            kind === "rebase-onto-base"
              ? ["--no-merges", "--cherry-pick", "--right-only", `${baseOid}...${headOid}`]
              : [incomingRange];

          const log = await git.log([`--max-count=${limit}`, ...revArgs]);
          const total = await countCommitsInRange(git, revArgs);
          // Measured separately and always in the base→branch direction. For a
          // rebase an empty replay set is produced both by a branch level with
          // the base and by one purely behind it, and only the second is moved
          // by the operation; for a merge this IS the incoming count, and
          // restating it costs one cheap local rev-list.
          const behind = await countCommitsInRange(git, [incomingRange]);

          return {
            kind,
            branch: branchName,
            baseBranch,
            blocker: treeBlocker,
            compareRef: target.compareRef,
            remote: target.remote,
            headOid,
            baseOid,
            total,
            behind,
            commits: log.all.map((commit) => ({
              hash: commit.hash,
              date: commit.date,
              message: commit.message,
              author: commit.author_name,
            })),
          };
        } catch (error) {
          throw asBaseIntegrationError(error, payload.cwd, "list-base-integration-commits");
        }
      }
    ),

    rebaseOntoBase: op(
      CHANNELS.GIT_REBASE_ONTO_BASE,
      async (payload: {
        cwd: string;
        baseBranch: string;
        expectedBranch?: string;
        expectedHeadOid?: string;
        expectedBaseOid?: string;
      }): Promise<void> => {
        checkRateLimit(CHANNELS.GIT_REBASE_ONTO_BASE, 3, 10_000);
        await runBaseIntegration(payload, "rebase-onto-base");
      }
    ),

    mergeBaseIntoBranch: op(
      CHANNELS.GIT_MERGE_BASE_INTO_BRANCH,
      async (payload: {
        cwd: string;
        baseBranch: string;
        expectedBranch?: string;
        expectedHeadOid?: string;
        expectedBaseOid?: string;
      }): Promise<void> => {
        checkRateLimit(CHANNELS.GIT_MERGE_BASE_INTO_BRANCH, 3, 10_000);
        await runBaseIntegration(payload, "merge-base");
      }
    ),
  },
});

const HEAD_FROM_FS_TIMEOUT_MS = 5_000;

/**
 * Whether HEAD names a commit, which decides how an unstage runs: a branch with
 * no commit yet has nothing to reset to, so it unstages with `rm --cached`.
 * Read from the git dir when it proves a commit; a miss there, or a read that
 * stalls, is no proof of an unborn branch, so it then asks git.
 */
async function hasHeadCommit(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "revparse">,
  cwd: string
): Promise<boolean> {
  const fromFs = await withTimeout(
    resolveGitDirFromFs(cwd).then((gitDir) => (gitDir ? resolveHeadOidFromGitDir(gitDir) : null)),
    HEAD_FROM_FS_TIMEOUT_MS,
    "HEAD read timed out"
  ).catch(() => null);
  if (fromFs) return true;
  try {
    await git.revparse(["HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The paths a reset to HEAD has to name to unstage `paths`, one group for each:
 * the path, plus the other half of any staged rename it names. Git resets only
 * the paths it is given, so resetting a rename's destination alone leaves its
 * source staged for deletion, and the next commit still deletes it.
 *
 * Pairs come from an unscoped status read, the one Review Hub lists rows from
 * (`status.renames` decides what is a pair): a pathspec would hide the half it
 * doesn't name. Only the index side matters, so a submodule's own working tree
 * isn't scanned. A copy's source is a file of its own and is left alone. The
 * read must answer before anything is reset; an empty answer from a git that
 * died would quietly bring the half-unstage back.
 */
async function withStagedRenamePartners(cwd: string, paths: string[]): Promise<string[][]> {
  const git = await createStrictExitGit(cwd);
  const entries = parsePorcelainV1Z(
    await git.raw([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=no",
      "--ignore-submodules=dirty",
    ])
  );
  const partners = new Map<string, string>();
  for (const entry of entries) {
    if (entry.x !== "R" || !entry.origPath) continue;
    partners.set(entry.path, entry.origPath);
    partners.set(entry.origPath, entry.path);
  }
  // Each path lands in one group only, even when both halves were asked for.
  const placed = new Set<string>();
  const groups: string[][] = [];
  for (const requested of paths) {
    if (placed.has(requested)) continue;
    const partner = partners.get(requested);
    const group = partner === undefined || placed.has(partner) ? [requested] : [requested, partner];
    for (const p of group) placed.add(p);
    groups.push(group);
  }
  return groups;
}

type DiffGit = Pick<Awaited<ReturnType<typeof createHardenedGit>>, "diff" | "raw">;

/**
 * Whether HEAD is a branch with no commit yet. Strict where
 * {@link hasHeadCommit} is lenient: a detached HEAD, a branch that names any
 * object however unreadable, or a probe that fails is not unborn. `git` must
 * reject every non-zero exit, or a listing from a git that died silently would
 * read as "no such branch".
 */
async function isUnbornBranch(git: DiffGit): Promise<boolean> {
  const ref = (await git.raw(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim();
  if (!ref.startsWith("refs/heads/")) return false;
  // A pattern also matches refs under it (`main` matches `main/x`), so only an
  // exact name counts. `for-each-ref` answers a missing ref with exit 0.
  const listed = await git.raw(["for-each-ref", "--format=%(refname)", ref]).catch(() => null);
  return listed !== null && !listed.split("\n").includes(ref);
}

const WORKING_DIFF_ARGS = ["--no-ext-diff", "--no-textconv"];

/**
 * The working tree against HEAD. A branch with no commit yet has no HEAD to
 * name, so it diffs against the empty tree instead: every tracked path shows as
 * a new file holding what is on disk now. Any other failure is HEAD's to report.
 */
async function diffWorkingTreeAgainstHead(git: DiffGit, cwd: string): Promise<string> {
  try {
    // `--` keeps a tracked file named HEAD from being read as the revision.
    return await git.diff([...WORKING_DIFF_ARGS, "HEAD", "--"]);
  } catch (error) {
    const strict = await createStrictExitGit(cwd).catch(() => null);
    if (!strict || !(await isUnbornBranch(strict))) throw error;
    const format = (await strict.raw(["rev-parse", "--show-object-format"]).catch(() => "")).trim();
    if (format !== "sha1" && format !== "sha256") throw error;
    return strict.diff([...WORKING_DIFF_ARGS, EMPTY_TREE[format], "--"]);
  }
}

/**
 * Whether git itself reports HEAD as `branch` with no commit yet (#17588).
 *
 * A HEAD that fails to read is no proof of that, so this asks for git's own
 * statement: porcelain v2 names the branch and says `(initial)` for its commit
 * in one answer. Any failure, or a different branch, is a no.
 */
async function isReportedUnbornBranch(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  branch: string
): Promise<boolean> {
  try {
    const out = await git.raw([
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=no",
      "--ignore-submodules=all",
    ]);
    const headers = out.split("\n").filter((line) => line.startsWith("# branch."));
    return (
      headers.includes("# branch.oid (initial)") && headers.includes(`# branch.head ${branch}`)
    );
  } catch {
    return false;
  }
}

export function registerGitWriteHandlers(_deps: HandlerDependencies): () => void {
  const handlers: Array<() => void> = [];

  const handleStageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = await createHardenedGit(payload.cwd);
    await git.add(["--", payload.filePath]);
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILE, handleStageFile));

  const handleUnstageFile = async (payload: { cwd: string; filePath: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILE, 30, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.filePath !== "string" || !payload.filePath) {
      throw new Error("Invalid file path");
    }

    const git = await createHardenedGit(payload.cwd);

    if (await hasHeadCommit(git, payload.cwd)) {
      await git.reset([
        "HEAD",
        "--",
        ...(await withStagedRenamePartners(payload.cwd, [payload.filePath])).flat(),
      ]);
    } else {
      await git.raw(["rm", "--cached", "--", payload.filePath]);
    }
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_FILE, handleUnstageFile));

  const validateFilePaths = (filePaths: unknown): string[] => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("filePaths must be a non-empty array");
    }
    for (const p of filePaths) {
      // A NUL would fail the spawn, possibly after earlier batches had landed.
      if (typeof p !== "string" || !p || p.includes("\0")) {
        throw new Error("Invalid file path in filePaths");
      }
    }
    return filePaths as string[];
  };

  /**
   * One git write per batch of pathspecs, so a large selection never overflows
   * the OS command line. Batches run in order and stop at the first failure.
   * The batches before it have landed, so the error names how many paths git
   * confirmed; "at least", because a failed `add` can still stage some of its
   * own batch. A failure before any batch landed passes through unchanged.
   *
   * Plural writes to one worktree run one at a time: two interleaving their
   * batches could leave an index that neither order of the two would. Each
   * picks its write command once its turn comes, from the repository as it is
   * then.
   */
  const writeInBatches = (
    cwd: string,
    paths: string[],
    verb: "Staged" | "Unstaged",
    prepare: () => Promise<{
      write: (batch: string[]) => Promise<unknown>;
      /** What to write, each group kept in one batch; `paths` one at a time when absent. */
      groups?: string[][];
    }>
  ): Promise<void> =>
    runExclusive(`git-index-batches:${path.resolve(cwd)}`, async () => {
      const requested = new Set(paths);
      let confirmed = 0;
      try {
        const { write, groups = paths.map((p) => [p]) } = await prepare();
        for (const batch of batchPathGroupsForArgv(groups)) {
          try {
            await write(batch);
          } catch (err) {
            if (confirmed === 0) throw err;
            const reason = formatErrorMessage(err, "Git failed without a message");
            throw new Error(
              `${verb} at least ${confirmed} of ${paths.length} files before Git stopped: ${reason}`,
              { cause: err }
            );
          }
          // Paths a group added beside a requested one aren't part of the count.
          confirmed += batch.filter((p) => requested.has(p)).length;
        }
      } finally {
        invalidateStagingDiffStatCache(cwd);
      }
    });

  const handleStageFiles = async (payload: { cwd: string; filePaths: string[] }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    await writeInBatches(payload.cwd, paths, "Staged", async () => {
      // Strict exit: a batch only counts as confirmed when git exits 0.
      const git = await createStrictExitGit(payload.cwd);
      return { write: (batch) => git.add(["--", ...batch]) };
    });
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILES, handleStageFiles));

  const handleUnstageFiles = async (payload: {
    cwd: string;
    filePaths: string[];
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    await writeInBatches(payload.cwd, paths, "Unstaged", async () => {
      // The probe keeps the default client, where a probe that dies silently
      // reads as a commit: `reset` then fails loudly on a truly unborn branch,
      // where taking `rm --cached` on a born one would stage deletions.
      const hasHead = await hasHeadCommit(await createHardenedGit(payload.cwd), payload.cwd);
      const git = await createStrictExitGit(payload.cwd);
      // Both forms replay cleanly over paths an earlier, partly failed run
      // already unstaged: `reset` matches nothing silently, and `rm` is told to.
      if (!hasHead) {
        return {
          write: (batch) => git.raw(["rm", "--cached", "--ignore-unmatch", "-q", "--", ...batch]),
        };
      }
      // A staged rename's halves share a batch: a failure between them would
      // leave the source staged for deletion, and a replay could no longer pair it.
      return {
        groups: await withStagedRenamePartners(payload.cwd, paths),
        write: (batch) => git.reset(["HEAD", "--", ...batch]),
      };
    });
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_FILES, handleUnstageFiles));

  const handleStageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);
    await git.add("-A");
    invalidateStagingDiffStatCache(cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_ALL, handleStageAll));

  const handleUnstageAll = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_ALL, 10, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);

    if (await hasHeadCommit(git, cwd)) {
      await git.reset(["HEAD"]);
    } else {
      await git.raw(["rm", "--cached", "-r", "."]);
    }
    invalidateStagingDiffStatCache(cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_UNSTAGE_ALL, handleUnstageAll));

  const handleCommit = async (payload: {
    cwd: string;
    message: string;
    expectedBranch?: string;
    expectedHeadOid?: string;
    expectedStagedIdentity?: string;
  }): Promise<GitCommitResult> => {
    checkRateLimit(CHANNELS.GIT_COMMIT, 5, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      throw new Error("Commit message is required");
    }
    const review = readCommitReview(payload);

    const git = await createHardenedGit(payload.cwd);
    await scanStagedFilesForConflictMarkers(git, payload.cwd);
    if (review) await requireReviewedStage(git, review, payload.cwd);
    const result = await git.commit(payload.message.trim());
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("git-commit");
    }
    const hash = result.commit || "";
    const committed = await readCommitted(git, hash);
    return {
      hash,
      summary: `${result.summary.changes} changed, ${result.summary.insertions} insertions(+), ${result.summary.deletions} deletions(-)`,
      ...committed,
      // The index can still change between the check above and git reading it,
      // so the caller is told what the commit really holds rather than trusting
      // the check. The commit has landed either way; a failed read is `null`.
      ...(review
        ? { stagedIdentity: await readCommittedStagedIdentity(payload.cwd, committed) }
        : {}),
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_COMMIT, handleCommit));

  const pushingCwds = new Set<string>();

  const handlePush = async (ctx: IpcContext, payload: GitPushPayload): Promise<void> => {
    const rawOpId = payload?.opId;
    const opId = normalizeOperationId(rawOpId);
    if (rawOpId !== undefined && opId === null) {
      throw new AppError({ code: "VALIDATION", message: "Invalid operation id" });
    }
    // Read before joining: a named push with a different review is a different
    // push, and must not attach to one already running under another approval.
    const review = readPushReview(payload);
    // Only a caller that names its operation (a remote view) is recorded,
    // published and joinable. Without an opId the push runs exactly as it
    // always has, and one already in flight for the cwd is a silent no-op.
    const input = opId
      ? {
          opId,
          kind: "git-push" as const,
          projectId: ctx.projectId,
          dedupKey: `git-push:${payload.cwd}`,
          fingerprint: JSON.stringify({ setUpstream: Boolean(payload.setUpstream), review }),
        }
      : null;
    // Reached only for a named push, so a local push never constructs the
    // registry.
    const joined = input ? getOperationRegistry().join<void>(input) : null;
    if (joined) return joined;
    if (pushingCwds.has(payload.cwd)) {
      if (!input) return;
      // An unnamed local push owns this cwd and has no record to join. Treating
      // this as the silent no-op a local caller gets would report success for
      // an opId that never resolves, so the named caller is told instead.
      throw new AppError({
        code: "VALIDATION",
        message: "A push is already running for this worktree",
        userMessage: "A push is already running for this worktree. Try again when it finishes.",
      });
    }

    checkRateLimit(CHANNELS.GIT_PUSH, 5, 10_000);
    validateCwd(payload?.cwd);

    pushingCwds.add(payload.cwd);
    try {
      if (input) {
        await getOperationRegistry().run(input, (op) => runPush(ctx, payload, review, op));
      } else {
        await runPush(ctx, payload, review, untrackedOperationHandle());
      }
    } finally {
      pushingCwds.delete(payload.cwd);
    }
  };

  const runPush = async (
    ctx: IpcContext,
    payload: { cwd: string; setUpstream?: boolean },
    review: GitPushReview | null,
    op: OperationHandle
  ): Promise<void> => {
    const git = await createAuthenticatedGit(payload.cwd);
    let branchName: string | undefined;
    let destination: ResolvedGitPushDestination | undefined;

    const sendProgress = (event: PushProgressEvent) => {
      sendToRendererContext(ctx, CHANNELS.GIT_PUSH_PROGRESS, event);
      op.progress({
        fraction: event.progress === null ? null : event.progress / 100,
        stage: event.stage,
        message: event.targetBranch ?? null,
      });
    };

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      branchName = branch.trim();

      // Resolved once, up front: the same destination labels the progress
      // event, is the only ref the push writes, and pins the lease ref if the
      // push is rejected. Refuses the push outright when git has no answer,
      // rather than reporting one target and writing to another.
      destination = review
        ? await requireReviewedTarget(git, branchName, review, payload.cwd)
        : await requireRemoteTarget(git, branchName, payload.cwd, "push");
      const targetBranch = formatGitPushDestination(destination);

      sendProgress({
        cwd: payload.cwd,
        stage: "target",
        progress: null,
        processed: null,
        total: null,
        targetBranch: targetBranch ?? undefined,
      });

      const authGit = await createAuthenticatedGit(payload.cwd, {
        progress: (data) => {
          sendProgress({
            cwd: payload.cwd,
            stage: data.stage,
            progress: data.progress,
            processed: data.processed,
            total: data.total,
          });
        },
      });

      // Tracking is written in the same push when it is asked for, when the
      // branch's upstream names a different branch (a plain push would fail on
      // that mismatch, and the confirm already showed the same-name
      // destination), or when the branch tracks nothing yet — the normal state
      // of a freshly created worktree branch, whose destination is the
      // repository's single remote, never a guessed `origin`.
      const setUpstream =
        payload.setUpstream ||
        destination.requiresUpstreamRepair ||
        destination.establishesUpstream;
      if (review) {
        await authGit.push(reviewedCommitPushArgs(review.headOid, destination));
      } else {
        await authGit.push([
          ...(setUpstream ? ["--set-upstream"] : []),
          ...singleBranchPushArgs(branchName, destination),
        ]);
      }
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
      if (review && setUpstream) {
        // Outside the rejection path below: the commit is already published,
        // so a failure here must not be reported as a failed push or capture a
        // lease. Untracked is what the next push finds and sets up again.
        try {
          await installPushUpstream(git, branchName, destination);
        } catch (error) {
          logWarn("[git-write] push landed but its upstream could not be recorded", {
            error: formatErrorMessage(error, "git config failed"),
          });
        }
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      if (error instanceof GitOperationError) throw error;
      const errorMessage = formatErrorMessage(error, "git push failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      // Capture the lease SHA at rejection time, not at click time. A
      // background fetch advancing the remote-tracking ref between here and the
      // user's force-push click would silently degrade `--force-with-lease` to
      // plain `--force`. Reads the ref of the destination we actually pushed to
      // (#11746) — reading origin's ref while pushing to a fork would lease
      // against the wrong repository. revparse may itself fail (ref never
      // fetched); on failure we omit leaseSha and the renderer suppresses the
      // force-push CTA.
      let leaseSha: string | undefined;
      if (gitReason === "push-rejected-outdated" && branchName && destination) {
        try {
          const sha = await git.revparse([destination.remoteTrackingRef]);
          leaseSha = sha.trim() || undefined;
        } catch {
          leaseSha = undefined;
        }
      }
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, { leaseSha, branchName }),
        {
          cwd: payload.cwd,
          op: "push",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          leaseSha,
          branchName,
        }
      );
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.GIT_PUSH, handlePush));

  const handlePullRebase = async (payload: {
    cwd: string;
    expectedBranch?: string;
    expectedHeadOid?: string;
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_PULL_REBASE, 3, 10_000);
    validateCwd(payload?.cwd);
    // Parsed before anything runs, so a malformed pin is refused rather than
    // read as "no pin" and the pull run unchecked.
    const review = readPullRebaseReview(payload);

    const git = await createAuthenticatedGit(payload.cwd);

    try {
      // `HEAD` on a detached HEAD, as `rev-parse --abbrev-ref` spelled it, so
      // the upstream lookup below fails closed in the same terms it always has.
      const headBranch = await readHeadBranch(git);
      const branchName = headBranch ?? "HEAD";
      if (review) requirePreviewedBranch(headBranch, review, payload.cwd);
      // Pull from the branch's UPSTREAM, not a hardcoded origin (#11746) and not
      // its push target: in a triangular workflow a branch tracks
      // `origin/release/topic` while pushing to `fork/topic`, and `git pull`
      // reads the upstream. Rebasing onto the wrong repository's history is as
      // destructive as pushing to it.
      const source = await requireRemoteTarget(
        git,
        branchName,
        payload.cwd,
        "pull-rebase",
        "upstream"
      );
      await requireNoOperationInProgress(git, payload.cwd, "pull-rebase");
      await requireNoTrackedChanges(git, payload.cwd, "pull-rebase");
      // Absent for a caller no confirm previewed (an agent dispatch), which
      // keeps today's unpinned behaviour.
      if (review) await requirePreviewedHead(git, review, payload.cwd);
      // The same pins the base rebase carries, for the same reason: each closes
      // a gap between what the confirm previewed and what git would do under a
      // user's config. `rebase.updateRefs` moves OTHER local branches pointing
      // into the replayed range; `rebase.rebaseMerges` recreates the merges the
      // preview's `--no-merges` replay set leaves out; `rebase.autoStash` would
      // replay over the changes the check above just refused. `-c` rather than
      // flags, because git ignores an unknown key where an unknown flag errors.
      await git.raw([
        "-c",
        "rebase.updateRefs=false",
        "-c",
        "rebase.rebaseMerges=false",
        "-c",
        "rebase.autoStash=false",
        "pull",
        "--rebase=true",
        source.remote,
        source.branch,
      ]);
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      // An unresolved push destination is already a classified, encoded
      // GitOperationError — re-wrapping would double-encode its message.
      if (error instanceof GitOperationError) throw error;
      const errorMessage = formatErrorMessage(error, "git pull --rebase failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage),
        {
          cwd: payload.cwd,
          op: "pull-rebase",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_PULL_REBASE, handlePullRebase));

  const handleForcePushWithLease = async (payload: {
    cwd: string;
    branchName: string;
    leaseSha: string;
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, 3, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
      throw new Error("Invalid branch name");
    }
    if (typeof payload.leaseSha !== "string" || !/^[0-9a-f]{4,64}$/i.test(payload.leaseSha)) {
      // Reject anything that isn't a hex SHA — the lease ref:sha form must
      // never receive arbitrary user input that could include `--` flags.
      throw new Error("Invalid lease SHA");
    }

    const git = await createAuthenticatedGit(payload.cwd);
    const branchName = payload.branchName.trim();

    try {
      const destination = await requireRemoteTarget(
        git,
        branchName,
        payload.cwd,
        "force-push-with-lease"
      );
      // The lease refname is the ref as it exists on the REMOTE side, which is
      // not always the local branch name (#11746). Passing the local name in a
      // triangular setup would lease against a ref that does not exist there,
      // and git treats an unmatched lease ref as no protection at all.
      await git.push([
        `--force-with-lease=refs/heads/${destination.branch}:${payload.leaseSha}`,
        "--force-if-includes",
        // A force-push is a normal way to reach this destination — the plain
        // push is rejected as non-fast-forward, the lease is captured, and the
        // user force-pushes. Without this the push lands but the tracking the
        // plain push would have written is never set, and a mismatched upstream
        // survives its own recovery, so the next push is broken again.
        ...(destination.requiresUpstreamRepair || destination.establishesUpstream
          ? ["--set-upstream"]
          : []),
        ...singleBranchPushArgs(branchName, destination),
      ]);
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
      }
    } catch (error) {
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push-error");
      }
      if (error instanceof GitOperationError) throw error;
      const errorMessage = formatErrorMessage(error, "git push --force-with-lease failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, {
          leaseSha: payload.leaseSha,
          branchName,
        }),
        {
          cwd: payload.cwd,
          op: "force-push-with-lease",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          leaseSha: payload.leaseSha,
          branchName,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_FORCE_PUSH_WITH_LEASE, handleForcePushWithLease));

  const handleListRemoteCommits = async (payload: {
    cwd: string;
    branchName: string;
    limit?: number;
  }): Promise<GitRemoteCommitPreview> => {
    checkRateLimit(CHANNELS.GIT_LIST_REMOTE_COMMITS, 10, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.branchName !== "string" || !payload.branchName.trim()) {
      throw new Error("Invalid branch name");
    }
    const branchName = payload.branchName.trim();
    const limit = Math.max(1, Math.min(GIT_REMOTE_COMMIT_PREVIEW_MAX, payload.limit ?? 20));

    const git = await createHardenedGit(payload.cwd);
    try {
      // Refuse rather than preview an empty list: this read is what the D2
      // force-push confirm shows, and "no commits to discard" from an
      // unresolvable destination reads as "safe to proceed" (#11746).
      const destination = await requireRemoteTarget(
        git,
        branchName,
        payload.cwd,
        "list-remote-commits"
      );
      // Ranged from the branch being force-pushed, not `HEAD`: the two diverge
      // whenever something checks out another branch between the rejected push
      // and the confirm, and a preview measured against the wrong local branch
      // can report "nothing to discard" for a push that discards plenty.
      const range = `refs/heads/${branchName}..${destination.remoteTrackingRef}`;

      // No `--no-merges` — the dialog's "N more" tail relies on the listed rows
      // matching what `--force-with-lease` would actually discard. Filtering
      // merges here would understate the discard preview against `total`.
      const log = await git.log([`--max-count=${limit}`, range]);
      // Counted over the same range as the rows, so the tail can't be computed
      // against a different repository's ref: `behindCount` comes from upstream
      // status, which in a triangular workflow tracks the fetch remote while the
      // force-push targets the push remote.
      const total = await countCommitsInRange(git, [range]);

      return {
        destination: { remote: destination.remote, branch: destination.branch },
        total,
        commits: log.all.map((commit) => ({
          hash: commit.hash,
          date: commit.date,
          message: commit.message,
          author: commit.author_name,
        })),
      };
    } catch (error) {
      if (error instanceof GitOperationError) throw error;
      const errorMessage = formatErrorMessage(error, "git log failed");
      const gitReason = classifyGitFailure(error, errorMessage);
      throw new GitOperationError(
        gitReason,
        encodeGitOperationErrorMessage(gitReason, errorMessage, { branchName }),
        {
          cwd: payload.cwd,
          op: "list-remote-commits",
          cause: error instanceof Error ? error : undefined,
          rawMessage: errorMessage,
          branchName,
        }
      );
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_LIST_REMOTE_COMMITS, handleListRemoteCommits));

  handlers.push(gitRemotePreviewNamespace.register());
  handlers.push(gitBaseIntegrationNamespace.register());

  const handleGetUsername = async (cwd: string): Promise<string | null> => {
    checkRateLimit(CHANNELS.GIT_GET_USERNAME, 20, 10_000);
    validateCwd(cwd);
    const git = await createHardenedGit(cwd);
    try {
      const { value } = await git.getConfig("user.name");
      return value || null;
    } catch {
      return null;
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_USERNAME, handleGetUsername));

  const handleGetStagingStatus = async (cwd: string): Promise<StagingStatus> => {
    checkRateLimit(CHANNELS.GIT_GET_STAGING_STATUS, 20, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);
    // Read on both sides of the status: an operation replaced while it runs
    // would otherwise hand back the old one's conflict counts with the new
    // one's identity, and a confirm built from that would describe one
    // operation while approving another.
    const gitDir = await resolveGitDir(git, cwd).catch(() => null);
    const operationIdBefore = gitDir ? await readCurrentRepoOperationId(gitDir) : null;
    const status = await git.status();

    const mapStatus = (s: string): GitStatus => {
      switch (s) {
        case "M":
          return "modified";
        case "A":
          return "added";
        case "D":
          return "deleted";
        case "R":
          return "renamed";
        case "C":
          return "copied";
        case "U":
          return "conflicted";
        case "?":
          return "untracked";
        case "!":
          return "ignored";
        default:
          return "modified";
      }
    };

    const staged: StagingFileEntry[] = [];
    const unstaged: StagingFileEntry[] = [];
    const conflicted: string[] = status.conflicted ?? [];

    const conflictedSet = new Set(conflicted);

    for (const file of status.files) {
      const indexStatus = file.index;
      const workingStatus = file.working_dir;

      if (conflictedSet.has(file.path)) {
        continue;
      }

      if (indexStatus && indexStatus !== " " && indexStatus !== "?") {
        staged.push({
          path: file.path,
          status: mapStatus(indexStatus),
          insertions: null,
          deletions: null,
        });
      }

      if (workingStatus && workingStatus !== " ") {
        unstaged.push({
          path: file.path,
          status: workingStatus === "?" ? "untracked" : mapStatus(workingStatus),
          insertions: null,
          deletions: null,
        });
      }
    }

    // Populate per-file churn from `git diff --numstat`. The handler is
    // rate-limited to 20/10s and getPerFileDiffStats caches per (cwd, headOid,
    // mode), so this adds at most two batched git invocations per refresh.
    // Untracked entries don't appear in numstat output and keep insertions/
    // deletions = null (renderer omits the churn span in that case).
    //
    // The git dir serves both the HEAD OID here and the operation-state
    // sentinels below, read from the filesystem rather than spawned. The OID
    // is still sampled after the status spawn, as the rev-parse it replaces
    // was; any shape the filesystem read can't prove falls back to it.
    let headOid = (gitDir ? await resolveHeadOidFromGitDir(gitDir) : null) ?? "";
    if (!headOid) {
      try {
        const out = (await git.revparse(["HEAD"])).trim();
        // On a branch with no commit, a tracked file named `HEAD` makes
        // rev-parse echo the path back rather than fail.
        headOid = FULL_OID_PATTERN.test(out) ? out : "";
      } catch {
        // No HEAD (unborn branch / empty repo): `git diff --cached` still
        // works against the empty tree, so churn is read with an empty OID.
      }
    }

    const stagedPaths = staged.map((entry) => entry.path);
    const unstagedTrackedPaths = unstaged
      .filter((entry) => entry.status !== "untracked")
      .map((entry) => entry.path);

    const [stagedStats, unstagedStats, remoteNames] = await Promise.all([
      getPerFileDiffStats(git, cwd, headOid, stagedPaths, "staged"),
      getPerFileDiffStats(git, cwd, headOid, unstagedTrackedPaths, "unstaged"),
      // Listed once and handed to the destination resolver below, which would
      // otherwise list them again for the push side and the pull side each.
      git.getRemotes().then(
        (remotes) => remotes.map((r) => r.name),
        () => [] as string[]
      ),
    ]);

    for (const entry of staged) {
      const stats = stagedStats.get(entry.path);
      if (stats) {
        entry.insertions = stats.insertions;
        entry.deletions = stats.deletions;
      }
    }
    for (const entry of unstaged) {
      const stats = unstagedStats.get(entry.path);
      if (stats) {
        entry.insertions = stats.insertions;
        entry.deletions = stats.deletions;
      }
    }

    let isDetachedHead = false;
    let currentBranch: string | null = status.current;
    if (status.current === "HEAD" || status.detached) {
      isDetachedHead = true;
      currentBranch = null;
    }

    const hasRemote = remoteNames.length > 0;
    // Only where HEAD could not be read: every branch with a commit skips it.
    const isUnbornBranch =
      !headOid && currentBranch !== null && (await isReportedUnbornBranch(git, currentBranch));

    // Best-effort: this is a general status read, so an unresolvable
    // destination degrades to `null` here rather than failing the whole status.
    // The confirm surfaces treat `null` as "block the write and say why"; the
    // write handlers resolve again and refuse independently (#11746).
    let pushDestination: StagingStatus["pushDestination"] = null;
    let pullSource: StagingStatus["pullSource"] = null;
    if (hasRemote && currentBranch) {
      // Shows the destination only, so whether a push would set tracking is
      // never read.
      const resolved = await resolveGitPushAndUpstream(git, currentBranch, remoteNames, {
        skipTrackingSetup: true,
      }).catch(() => null);
      const push = resolved?.push;
      const pull = resolved?.upstream;
      if (push?.status === "resolved") {
        pushDestination = { remote: push.destination.remote, branch: push.destination.branch };
      }
      if (pull?.status === "resolved") {
        pullSource = { remote: pull.destination.remote, branch: pull.destination.branch };
      }
    }

    let conflictedFiles: ConflictedFileEntry[] = [];
    if (conflicted.length > 0) {
      try {
        const porcelain = await git.raw(PORCELAIN_V2_CONFLICT_ARGS);
        conflictedFiles = parsePorcelainV2Conflicts(porcelain);
      } catch {
        // Fall back to the simple-git path list without XY labels.
      }
      if (conflictedFiles.length === 0) {
        conflictedFiles = conflicted.map((p) => ({ path: p, xy: "UU", label: "conflicted" }));
      }
    }

    let repoState: RepoState = conflicted.length > 0 ? "DIRTY" : "CLEAN";
    let rebaseStep: number | null = null;
    let rebaseTotalSteps: number | null = null;
    let rebaseSequence: RebaseSequence | null = null;
    // An unresolved git dir falls back to CLEAN/DIRTY from the index alone.
    if (gitDir) {
      try {
        const detected = await detectRepoOperationState(gitDir, conflicted.length > 0);
        repoState = detected.state;
        rebaseStep = detected.rebaseStep;
        rebaseTotalSteps = detected.rebaseTotalSteps;
        rebaseSequence = detected.rebaseSequence;
      } catch {
        // Same fallback when the sentinel reads fail.
      }
    }
    const halted = asHaltedOperation(repoState);
    const operationIdAfter =
      gitDir && halted && operationIdBefore !== null
        ? await readRepoOperationId(gitDir, halted)
        : null;
    const repoOperationId = operationIdAfter === operationIdBefore ? operationIdAfter : null;

    // Only a stopped operation puts cleanly merged paths in the index beside
    // the resolved ones, so nothing else pays for the read. After the last
    // conflict clears the sentinel still names the operation, so the read still
    // runs then.
    let resolveUndoPaths: string[] | undefined;
    if (staged.length > 0 && repoState !== "CLEAN" && repoState !== "DIRTY") {
      try {
        // A git that died partway must not pass for a shorter list of resolutions.
        const strictGit = await createStrictExitGit(cwd);
        resolveUndoPaths =
          parseResolveUndoPaths(await strictGit.raw(RESOLVE_UNDO_ARGS)) ?? undefined;
      } catch {
        // Left out, so the panel names the staged paths without claiming a split.
      }
    }

    return {
      staged,
      unstaged,
      conflicted,
      conflictedFiles,
      ...(resolveUndoPaths ? { resolveUndoPaths } : {}),
      isDetachedHead,
      currentBranch,
      hasRemote,
      pushDestination,
      pullSource,
      ...(isUnbornBranch ? { isUnbornBranch: true as const } : {}),
      repoState,
      repoOperationId,
      rebaseStep,
      rebaseTotalSteps,
      rebaseSequence,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus));

  const handleAbortRepositoryOperation = async (cwd: string, expected?: unknown): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);
    const pin = readRepoOperationPin(expected);

    const git = await createHardenedGit(cwd);
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);
    await requireChosenRepoOperation(gitDir, state, pin, cwd, "abort");

    switch (state) {
      case "MERGING":
        await git.merge(["--abort"]);
        return;
      case "REBASING":
        await git.rebase(["--abort"]);
        return;
      case "CHERRY_PICKING":
        await git.raw(["cherry-pick", "--abort"]);
        return;
      case "REVERTING":
        await git.raw(["revert", "--abort"]);
        return;
      case "APPLYING_MAILBOX":
        // `git rebase --abort` refuses an am session outright; `git am --abort`
        // also declines to rewind when HEAD moved since the stop, which is
        // git's call to make, not ours.
        await git.raw(["am", "--abort"]);
        return;
      default:
        throw new Error("No repository operation is in progress");
    }
  };
  handlers.push(
    typedHandle(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, handleAbortRepositoryOperation)
  );

  const handleContinueRepositoryOperation = async (
    cwd: string,
    expected?: unknown
  ): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);
    const pin = readRepoOperationPin(expected);

    // The continue profile carries the hardened env plus editor suppression in
    // the one env it is built with: a later .env() would replace the hardening
    // wholesale (#7058, #10786), and the plain hardened profile is not allowed
    // GIT_EDITOR at all.
    const git = await createContinueGit(cwd);
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);
    await requireChosenRepoOperation(gitDir, state, pin, cwd, "continue");

    switch (state) {
      case "MERGING":
        // `git merge --continue` rejects extra args ("--continue expects no
        // arguments", exit 129); the env overlay (GIT_MERGE_AUTOEDIT=no,
        // GIT_EDITOR=true) suppresses the editor instead of a `--no-edit` flag.
        await git.merge(["--continue"]);
        return;
      case "REBASING":
        // `git rebase --continue` has no `--no-edit`; the env overlay covers it.
        await git.rebase(["--continue"]);
        return;
      case "CHERRY_PICKING":
        await git.raw(["cherry-pick", "--continue", "--no-edit"]);
        return;
      case "REVERTING":
        await git.raw(["revert", "--continue", "--no-edit"]);
        return;
      case "APPLYING_MAILBOX":
        // Commits the staged resolution with the patch's own message and
        // author, so there is no message to edit.
        await git.raw(["am", "--continue"]);
        return;
      default:
        throw new Error("No repository operation is in progress");
    }
  };
  handlers.push(
    typedHandle(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, handleContinueRepositoryOperation)
  );

  const DIFF_LINE_LIMIT = 500;

  const handleGetWorkingDiff = async (payload: {
    cwd: string;
    type: "unstaged" | "staged" | "head";
  }): Promise<string> => {
    checkRateLimit(CHANNELS.GIT_GET_WORKING_DIFF, 20, 10_000);
    validateCwd(payload?.cwd);
    const diffType = payload?.type;
    if (diffType !== "unstaged" && diffType !== "staged" && diffType !== "head") {
      throw new Error("Invalid diff type: must be 'unstaged', 'staged', or 'head'");
    }

    const git = await createHardenedGit(payload.cwd);

    let raw: string;
    switch (diffType) {
      case "unstaged":
        raw = await git.diff([...WORKING_DIFF_ARGS]);
        break;
      case "staged":
        raw = await git.diff([...WORKING_DIFF_ARGS, "--cached"]);
        break;
      case "head":
        raw = await diffWorkingTreeAgainstHead(git, payload.cwd);
        break;
    }

    if (!raw) return "";

    const lines = raw.split("\n");
    if (lines.length > DIFF_LINE_LIMIT) {
      return (
        lines.slice(0, DIFF_LINE_LIMIT).join("\n") +
        `\n[Diff truncated — showing first ${DIFF_LINE_LIMIT} of ${lines.length} lines]`
      );
    }

    return raw;
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_WORKING_DIFF, handleGetWorkingDiff));

  // Rejects path traversal, absolute paths, and the worktree root itself
  // (`.`, `./`). Resolves the file under `cwd` and confirms the resolved path
  // stays strictly inside the worktree boundary — the `cwd + path.sep` guard
  // also blocks sibling-directory matches (e.g. `/foo` matching `/foobar/...`).
  const validateFilePathUnderCwd = (cwd: string, filePath: string): void => {
    if (typeof filePath !== "string" || !filePath) {
      throw new Error("Invalid file path");
    }
    if (path.isAbsolute(filePath)) {
      throw new Error("Invalid file path: must be relative to the worktree");
    }
    const resolvedCwd = path.resolve(cwd);
    const resolved = path.resolve(resolvedCwd, filePath);
    const boundary = resolvedCwd.endsWith(path.sep) ? resolvedCwd : resolvedCwd + path.sep;
    // Strict prefix match — `resolved === resolvedCwd` (i.e. `.`/`./`) is
    // rejected so the renderer can't accidentally invoke a worktree-wide
    // `git checkout --ours -- .` resolving every conflict at once.
    if (!resolved.startsWith(boundary)) {
      throw new Error("Invalid file path: must point at a file inside the worktree");
    }
  };

  const handleScanConflictMarkers = async (
    payload: GitScanConflictMarkersPayload
  ): Promise<ConflictMarkerScanEntry[]> => {
    checkRateLimit(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, 30, 10_000);
    validateCwd(payload?.cwd);
    if (!Array.isArray(payload?.filePaths)) {
      throw new Error("Invalid file paths: must be an array");
    }
    if (payload.filePaths.length === 0) return [];

    const skipped = (filePath: string): ConflictMarkerScanEntry => ({
      path: filePath,
      hunkCount: null,
      hasMarkers: null,
      firstMarkerLine: null,
    });

    const scanOne = async (filePath: string): Promise<ConflictMarkerScanEntry> => {
      try {
        validateFilePathUnderCwd(payload.cwd, filePath);
        const absolute = path.resolve(payload.cwd, filePath);
        // Through the project I/O gate, so a worktree on a dead mount fails its
        // own reads instead of holding Main's threadpool.
        const stat = await projectIo.run(payload.cwd, () => fs.promises.stat(absolute));
        if (!stat.isFile() || stat.size > STAGED_FILE_SIZE_CAP) return skipped(filePath);
        const content = await projectIo.run(payload.cwd, () => fs.promises.readFile(absolute));
        return { path: filePath, ...scanConflictMarkerText(content) };
      } catch (error) {
        // The gate refused or gave up on the read, so nobody looked: a skipped
        // entry would read as a deletion conflict's missing file and stage it
        // unasked, where a failed scan makes the renderer ask first.
        if (isProjectIoError(error)) throw error;
        // Treat any other per-file error as a degraded scan result — the UI
        // hides the badge rather than blocking the worklist on a single bad path.
        return skipped(filePath);
      }
    };

    // One file at a time: the gate runs one read per worktree anyway, so more
    // in flight would only queue there, ahead of a later scan's files.
    const results: ConflictMarkerScanEntry[] = [];
    for (const filePath of payload.filePaths) {
      results.push(await scanOne(filePath));
    }
    return results;
  };
  handlers.push(typedHandle(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, handleScanConflictMarkers));

  const handleCheckoutOursTheirs = async (payload: GitCheckoutOursTheirsPayload): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, 30, 10_000);
    validateCwd(payload?.cwd);
    validateFilePathUnderCwd(payload.cwd, payload?.filePath);
    const { resolution, side } = payload;
    if (resolution !== "checkout" && resolution !== "delete") {
      throw new Error("Invalid resolution: must be 'checkout' or 'delete'");
    }
    const validSides: string[] =
      resolution === "delete" ? ["ours", "theirs", "both"] : ["ours", "theirs"];
    if (!validSides.includes(side)) {
      throw new Error(`Invalid side: must be one of ${validSides.join(", ")}`);
    }

    const git = await createHardenedGit(payload.cwd);
    // The renderer confirmed an overwrite or a deletion from a status read that
    // may be stale. Check the stages it was based on, and refuse rather than run
    // the other operation: stage 2 is ours, stage 3 is theirs.
    const stages = new Set<string>();
    let isSubmodule = false;
    const unmerged = await git.raw(["ls-files", "--unmerged", "-z", "--", payload.filePath]);
    for (const record of unmerged.split("\0")) {
      const tab = record.indexOf("\t");
      // A directory pathspec also matches its descendants.
      if (tab === -1 || record.slice(tab + 1) !== payload.filePath) continue;
      const [mode, , stage] = record.slice(0, tab).split(" ");
      stages.add(stage ?? "");
      if (mode === "160000") isSubmodule = true;
    }
    const sideStages = side === "both" ? ["2", "3"] : [side === "ours" ? "2" : "3"];
    const expectPresent = resolution === "checkout";
    if (stages.size === 0 || sideStages.some((stage) => stages.has(stage) !== expectPresent)) {
      throw new Error(
        `The conflict in ${payload.filePath} has changed since it was listed. Review it and choose again.`
      );
    }

    if (resolution === "delete") {
      // On a submodule `git rm` also removes its checkout and edits
      // `.gitmodules`, more than a confirm that names one file covers.
      if (isSubmodule) {
        throw new Error(
          `${payload.filePath} is a submodule. Resolve its deletion with git in a terminal.`
        );
      }
      // `git rm` resolves the unmerged path as deleted and removes the file,
      // whatever edits it carries.
      await git.raw(["rm", "-q", "--", payload.filePath]);
      return;
    }
    // `checkout --ours/--theirs` leaves the file unstaged — the conflict markers
    // are still in the index. Follow with `git add` so the resolution lands in
    // the staged tree and the file falls off the conflicted list.
    await git.raw(["checkout", side === "ours" ? "--ours" : "--theirs", "--", payload.filePath]);
    await git.add(["--", payload.filePath]);
  };
  handlers.push(typedHandle(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, handleCheckoutOursTheirs));

  // Normalizes a path for comparison against git config safe.directory entries:
  // resolve → realpath (fall back to resolved) → forward slashes.
  const canonicalizeSafeDirectoryPath = async (p: string): Promise<string> => {
    const resolved = path.resolve(p);
    let canonical: string;
    try {
      canonical = await realpath(resolved);
    } catch {
      canonical = resolved;
    }
    return canonical.replace(/\\/g, "/");
  };

  // Resolves the "fatal: detected dubious ownership" error (CVE-2022-24765) by
  // adding the repo path to the user's global safe.directory list. The caller
  // is expected to retry the original operation after this succeeds.
  // Detection lives in the renderer (see src/store/projectStore.ts) — this
  // handler only writes the config. Inline because #5369 (unified git error
  // taxonomy) has no PR yet.
  const handleMarkSafeDirectory = async (repoPath: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_MARK_SAFE_DIRECTORY, 5, 10_000);
    if (typeof repoPath !== "string" || !repoPath.trim()) {
      throw new Error("Invalid path: must be a non-empty string");
    }
    if (!path.isAbsolute(repoPath)) {
      throw new Error("Invalid path: must be absolute");
    }
    const normalized = await canonicalizeSafeDirectoryPath(repoPath);

    // Check whether the path is already configured to avoid unbounded
    // duplicate entries in ~/.gitconfig. Exit code 1 (no entries set) is
    // expected for first-time users and must not propagate as an error.
    let alreadyConfigured = false;
    const git = await resolveExecutableForSpawn("git");
    // Without an inherited GIT_CONFIG_GLOBAL, so the exception lands in the
    // global config the hardened profiles read.
    const env = { ...getSanitizedProcessEnv(), LC_ALL: "C" };
    try {
      const { stdout } = await execFileAsync(
        git,
        ["config", "--global", "--get-all", "safe.directory"],
        { env, windowsHide: true }
      );
      const entries = stdout
        .split("\n")
        .map((e) => e.trim())
        .filter(Boolean);
      for (const entry of entries) {
        const canonicalized = await canonicalizeSafeDirectoryPath(entry);
        if (canonicalized === normalized) {
          alreadyConfigured = true;
          break;
        }
      }
    } catch (err) {
      if ((err as { code?: number }).code !== 1) {
        throw err;
      }
      // Exit code 1: no safe.directory entries exist — not configured.
    }

    if (!alreadyConfigured) {
      await execFileAsync(git, ["config", "--global", "--add", "safe.directory", normalized], {
        env,
        windowsHide: true,
      });
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_MARK_SAFE_DIRECTORY, handleMarkSafeDirectory));

  return () => handlers.forEach((cleanup) => cleanup());
}
