// eager-import-allow: reads git config via store.get synchronously while servicing git-write IPC
import { execFile } from "node:child_process";
import fs from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { checkRateLimit, typedHandle, typedHandleWithContext, sendToRenderer } from "../utils.js";
import type { HandlerDependencies, IpcContext } from "../types.js";
import type { PushProgressEvent } from "../../../shared/types/ipc/gitPush.js";
import type {
  ConflictedFileEntry,
  GitPushCommitPreview,
  GitRebaseCommitPreview,
  GitRemoteCommitPreview,
  GitStatus,
  RebaseSequence,
  RepoState,
  StagingStatus,
} from "../../../shared/types/git.js";
import { GIT_REMOTE_COMMIT_PREVIEW_MAX } from "../../../shared/types/git.js";
import {
  validateCwd,
  createHardenedGit,
  createAuthenticatedGit,
  buildContinueEnv,
} from "../../utils/hardenedGit.js";
import { getPerFileDiffStats, invalidateStagingDiffStatCache } from "../../utils/git.js";
import { store } from "../../store.js";
import { getSoundService } from "../../services/getSoundService.js";
import type * as SoundServiceModule from "../../services/SoundService.js";
import { detectRepoOperationState, resolveGitDir } from "../../services/git/repoOperationState.js";
import { parsePorcelainV2Conflicts } from "../../services/git/porcelainConflicts.js";
import {
  STAGED_FILE_SIZE_CAP,
  scanStagedFilesForConflictMarkers,
} from "../../services/git/conflictMarkerScan.js";

type SoundId = keyof typeof SoundServiceModule.SOUND_FILES;

function playSoundFireAndForget(id: SoundId): void {
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
import { GitOperationError } from "../../utils/errorTypes.js";
import {
  resolveGitPushDestination,
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

/** Upper bound on the one network read the push preview is allowed to make. */
const PUSH_PREVIEW_LS_REMOTE_TIMEOUT_MS = 4000;

/**
 * The destination branch's tip according to the REMOTE, or `undefined` when the
 * remote could not be asked.
 *
 * `null` is a real answer — the remote replied and has no such branch — and is
 * what lets the preview say a push creates a branch instead of guessing from the
 * absence of a local ref. `undefined` is "no answer", which the caller must
 * treat as unverified rather than as absence.
 *
 * Bounded and swallowed on purpose. This runs while a confirm dialog is waiting,
 * so a slow or unreachable remote must degrade the preview's precision, never
 * hold the dialog open — the local approximation is still shown, labelled.
 */
async function readRemoteBranchTip(
  git: Pick<Awaited<ReturnType<typeof createHardenedGit>>, "raw">,
  remote: string,
  branch: string
): Promise<string | null | undefined> {
  try {
    const out = await Promise.race([
      // `--` before the remote so a remote whose name survived the argv guard
      // still cannot be read as an option, and the ref given in full.
      git.raw(["ls-remote", "--heads", "--", remote, `refs/heads/${branch}`]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("ls-remote timed out")),
          PUSH_PREVIEW_LS_REMOTE_TIMEOUT_MS
        )
      ),
    ]);
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line) return null;
    const sha = line.split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : undefined;
  } catch {
    return undefined;
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
          const localRef = `refs/heads/${branchName}`;
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
          if (hasRemoteRef) {
            rangeBasis = "tracked";
            revArgs = [`${destination.remoteTrackingRef}..${localRef}`];
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
              revArgs = [localRef];
            } else if (remoteTip && (await refExists(git, remoteTip))) {
              // The remote named a tip this repository already holds, so the
              // delta is exact even without a tracking ref.
              rangeBasis = "tracked";
              revArgs = [`${remoteTip}..${localRef}`];
            } else {
              // No answer, or a tip we cannot resolve. Fall back to the local
              // approximation and mark it as what it is.
              rangeBasis = "unverified";
              revArgs = [localRef, "--not", `--remotes=${destination.remote}`];
            }
          }

          // No `--no-merges`: the "N more" tail is only honest while the listed
          // rows and `total` describe the same set the push would write.
          const log = await git.log([`--max-count=${limit}`, ...revArgs]);
          const total = await countCommitsInRange(git, revArgs);

          return {
            destination: { remote: destination.remote, branch: destination.branch },
            rangeBasis,
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
            `${upstream.remoteTrackingRef}...${localRef}`,
          ];
          const log = await git.log([`--max-count=${limit}`, ...revArgs]);
          const total = await countCommitsInRange(git, revArgs);
          // Measured separately and in the other direction: an empty replay set
          // is produced both by a branch level with its upstream and by one
          // purely behind it, and only the second is moved by the rebase.
          const behind = await countCommitsInRange(git, [
            `${localRef}..${upstream.remoteTrackingRef}`,
          ]);

          return {
            upstream: { remote: upstream.remote, branch: upstream.branch },
            rangeBasis: "tracked",
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

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      await git.reset(["HEAD", "--", payload.filePath]);
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
      if (typeof p !== "string" || !p) {
        throw new Error("Invalid file path in filePaths");
      }
    }
    return filePaths as string[];
  };

  const handleStageFiles = async (payload: { cwd: string; filePaths: string[] }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_STAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    const git = await createHardenedGit(payload.cwd);
    await git.add(["--", ...paths]);
    invalidateStagingDiffStatCache(payload.cwd);
  };
  handlers.push(typedHandle(CHANNELS.GIT_STAGE_FILES, handleStageFiles));

  const handleUnstageFiles = async (payload: {
    cwd: string;
    filePaths: string[];
  }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_UNSTAGE_FILES, 10, 10_000);
    validateCwd(payload?.cwd);
    const paths = validateFilePaths(payload?.filePaths);

    const git = await createHardenedGit(payload.cwd);

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      await git.reset(["HEAD", "--", ...paths]);
    } else {
      await git.raw(["rm", "--cached", "--", ...paths]);
    }
    invalidateStagingDiffStatCache(payload.cwd);
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

    let hasHead = true;
    try {
      await git.revparse(["HEAD"]);
    } catch {
      hasHead = false;
    }

    if (hasHead) {
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
  }): Promise<{ hash: string; summary: string }> => {
    checkRateLimit(CHANNELS.GIT_COMMIT, 5, 10_000);
    validateCwd(payload?.cwd);
    if (typeof payload.message !== "string" || !payload.message.trim()) {
      throw new Error("Commit message is required");
    }

    const git = await createHardenedGit(payload.cwd);
    await scanStagedFilesForConflictMarkers(git);
    const result = await git.commit(payload.message.trim());
    if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
      playSoundFireAndForget("git-commit");
    }
    return {
      hash: result.commit || "",
      summary: `${result.summary.changes} changed, ${result.summary.insertions} insertions(+), ${result.summary.deletions} deletions(-)`,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_COMMIT, handleCommit));

  const pushingCwds = new Set<string>();

  const handlePush = async (
    ctx: IpcContext,
    payload: { cwd: string; setUpstream?: boolean }
  ): Promise<void> => {
    if (pushingCwds.has(payload.cwd)) return;

    checkRateLimit(CHANNELS.GIT_PUSH, 5, 10_000);
    validateCwd(payload?.cwd);

    pushingCwds.add(payload.cwd);
    const git = await createAuthenticatedGit(payload.cwd);
    let branchName: string | undefined;
    let destination: ResolvedGitPushDestination | undefined;
    const senderWindow = ctx.senderWindow;

    const sendProgress = (event: PushProgressEvent) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        sendToRenderer(senderWindow, CHANNELS.GIT_PUSH_PROGRESS, event);
      }
    };

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      branchName = branch.trim();

      // Resolved once, up front: the same destination labels the progress
      // event, backs the `--set-upstream` argv, and pins the lease ref if the
      // push is rejected. Refuses the push outright when git has no answer,
      // rather than reporting one target and writing to another.
      destination = await requireRemoteTarget(git, branchName, payload.cwd, "push");
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

      // `<local>:<remote>` explicitly, because the remote-side branch need not
      // share the local name — with `push.default=upstream` a local `topic` can
      // push to `release/topic`.
      const refspec = `${branchName}:${destination.branch}`;

      // `requiresUpstreamRepair` forces the explicit form too. That branch's
      // upstream names a different branch, so a plain `git push` fails on the
      // name mismatch rather than on a missing upstream — the recovery in the
      // catch below would never see the message it looks for. Pushing with
      // `--set-upstream` to the destination the confirm already showed both
      // completes the push and rewrites the tracking config that broke it.
      if (payload.setUpstream || destination.requiresUpstreamRepair) {
        await authGit.push(["--set-upstream", destination.remote, refspec]);
      } else {
        try {
          await authGit.push();
        } catch (pushErr) {
          const msg = formatErrorMessage(pushErr, "git push failed");
          if (msg.includes("no upstream branch") || msg.includes("has no upstream")) {
            // The branch has no tracking config yet — the normal state of a
            // freshly created worktree branch. `destination` was resolved above
            // and is either git's own answer or the repository's single remote,
            // never a guessed `origin`, so establishing tracking to it is safe.
            await authGit.push(["--set-upstream", destination.remote, refspec]);
          } else {
            throw pushErr;
          }
        }
      }
      if (store.get("notificationSettings").uiFeedbackSoundEnabled) {
        playSoundFireAndForget("git-push");
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
    } finally {
      pushingCwds.delete(payload.cwd);
    }
  };
  handlers.push(typedHandleWithContext(CHANNELS.GIT_PUSH, handlePush));

  const handlePullRebase = async (payload: { cwd: string }): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_PULL_REBASE, 3, 10_000);
    validateCwd(payload?.cwd);

    const git = await createAuthenticatedGit(payload.cwd);

    try {
      const branch = await git.revparse(["--abbrev-ref", "HEAD"]);
      const branchName = branch.trim();
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
      await git.pull(source.remote, source.branch, ["--rebase"]);
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
      await git.push(destination.remote, `${branchName}:${destination.branch}`, [
        `--force-with-lease=${destination.branch}:${payload.leaseSha}`,
        "--force-if-includes",
        // A force-push is a normal way to reach this destination — the plain
        // push is rejected as non-fast-forward, the lease is captured, and the
        // user force-pushes. Without this the push lands but the tracking
        // config that made the destination unresolvable in the first place
        // survives the recovery, so the next push is broken again.
        ...(destination.requiresUpstreamRepair ? ["--set-upstream"] : []),
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
    let headOid = "";
    try {
      headOid = (await git.revparse(["HEAD"])).trim();
    } catch {
      // No HEAD (unborn branch / empty repo) — staged numstat would also throw;
      // skip churn entirely below.
    }

    const stagedPaths = staged.map((entry) => entry.path);
    const unstagedTrackedPaths = unstaged
      .filter((entry) => entry.status !== "untracked")
      .map((entry) => entry.path);

    const [stagedStats, unstagedStats] = await Promise.all([
      getPerFileDiffStats(git, cwd, headOid, stagedPaths, "staged"),
      getPerFileDiffStats(git, cwd, headOid, unstagedTrackedPaths, "unstaged"),
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

    let hasRemote = false;
    try {
      const remotes = await git.getRemotes();
      hasRemote = remotes.length > 0;
    } catch {
      // no remotes
    }

    // Best-effort: this is a general status read, so an unresolvable
    // destination degrades to `null` here rather than failing the whole status.
    // The confirm surfaces treat `null` as "block the write and say why"; the
    // write handlers resolve again and refuse independently (#11746).
    let pushDestination: StagingStatus["pushDestination"] = null;
    let pullSource: StagingStatus["pullSource"] = null;
    if (hasRemote && currentBranch) {
      const [push, pull] = await Promise.all([
        resolveGitPushDestination(git, currentBranch).catch(() => null),
        resolveGitUpstream(git, currentBranch).catch(() => null),
      ]);
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
        const porcelain = await git.raw(["-c", "core.quotepath=false", "status", "--porcelain=v2"]);
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
    try {
      const gitDir = await resolveGitDir(git, cwd);
      const detected = await detectRepoOperationState(gitDir, conflicted.length > 0);
      repoState = detected.state;
      rebaseStep = detected.rebaseStep;
      rebaseTotalSteps = detected.rebaseTotalSteps;
      rebaseSequence = detected.rebaseSequence;
    } catch {
      // If git-dir resolution fails, fall back to CLEAN/DIRTY from index alone.
    }

    return {
      staged,
      unstaged,
      conflicted,
      conflictedFiles,
      isDetachedHead,
      currentBranch,
      hasRemote,
      pushDestination,
      pullSource,
      repoState,
      rebaseStep,
      rebaseTotalSteps,
      rebaseSequence,
    };
  };
  handlers.push(typedHandle(CHANNELS.GIT_GET_STAGING_STATUS, handleGetStagingStatus));

  const handleAbortRepositoryOperation = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);

    const git = await createHardenedGit(cwd);
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);

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
      default:
        throw new Error("No merge, rebase, cherry-pick, or revert operation is in progress");
    }
  };
  handlers.push(
    typedHandle(CHANNELS.GIT_ABORT_REPOSITORY_OPERATION, handleAbortRepositoryOperation)
  );

  const handleContinueRepositoryOperation = async (cwd: string): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CONTINUE_REPOSITORY_OPERATION, 5, 10_000);
    validateCwd(cwd);

    // One .env() call only: simple-git's .env() replaces the spawn env
    // wholesale, so re-stating the full hardened env (plus editor suppression)
    // via buildContinueEnv is the only way to keep createHardenedGit's
    // hardening intact on the continue path (#7058, #10786).
    const git = (await createHardenedGit(cwd)).env(buildContinueEnv());
    const gitDir = await resolveGitDir(git, cwd);
    const { state } = await detectRepoOperationState(gitDir, false);

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
      default:
        throw new Error("No merge, rebase, cherry-pick, or revert operation is in progress");
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
        raw = await git.diff(["--no-ext-diff", "--no-textconv"]);
        break;
      case "staged":
        raw = await git.diff(["--no-ext-diff", "--no-textconv", "--cached"]);
        break;
      case "head":
        raw = await git.diff(["--no-ext-diff", "--no-textconv", "HEAD"]);
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

    // `g` flag is required for `matchAll`/`exec` iteration; the regex is local
    // to this call so the shared `CONFLICT_MARKER_RE` (single-match, `/m`) is
    // untouched. Counts only opening `<<<<<<<` markers — one per hunk.
    const HUNK_OPEN_RE = /^<{7}/gm;

    const scanOne = async (filePath: string): Promise<ConflictMarkerScanEntry> => {
      try {
        validateFilePathUnderCwd(payload.cwd, filePath);
        const absolute = path.resolve(payload.cwd, filePath);
        const stat = await fs.promises.stat(absolute);
        if (!stat.isFile() || stat.size > STAGED_FILE_SIZE_CAP) {
          return { path: filePath, hunkCount: null, firstMarkerLine: null };
        }
        const content = await fs.promises.readFile(absolute, "utf8");
        // BOM-strip so a marker on line 1 isn't shifted past the `^` anchor.
        const probe = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
        let hunkCount = 0;
        let firstMarkerLine: number | null = null;
        let match: RegExpExecArray | null;
        HUNK_OPEN_RE.lastIndex = 0;
        while ((match = HUNK_OPEN_RE.exec(probe)) !== null) {
          hunkCount++;
          if (firstMarkerLine === null) {
            // Compute 1-based line number from byte offset within the probed string.
            let line = 1;
            for (let i = 0; i < match.index; i++) {
              if (probe.charCodeAt(i) === 0x0a) line++;
            }
            firstMarkerLine = line;
          }
        }
        return { path: filePath, hunkCount, firstMarkerLine };
      } catch {
        // Treat any per-file error as a degraded scan result — the UI hides
        // the badge rather than blocking the worklist on a single bad path.
        return { path: filePath, hunkCount: null, firstMarkerLine: null };
      }
    };

    return Promise.all(payload.filePaths.map(scanOne));
  };
  handlers.push(typedHandle(CHANNELS.GIT_SCAN_CONFLICT_MARKERS, handleScanConflictMarkers));

  const handleCheckoutOursTheirs = async (payload: GitCheckoutOursTheirsPayload): Promise<void> => {
    checkRateLimit(CHANNELS.GIT_CHECKOUT_OURS_THEIRS, 30, 10_000);
    validateCwd(payload?.cwd);
    validateFilePathUnderCwd(payload.cwd, payload?.filePath);
    if (payload.side !== "ours" && payload.side !== "theirs") {
      throw new Error("Invalid side: must be 'ours' or 'theirs'");
    }

    const git = await createHardenedGit(payload.cwd);
    const flag = payload.side === "ours" ? "--ours" : "--theirs";
    // `checkout --ours/--theirs` leaves the file unstaged — the conflict markers
    // are still in the index. Follow with `git add` so the resolution lands in
    // the staged tree and the file falls off the conflicted list.
    await git.raw(["checkout", flag, "--", payload.filePath]);
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
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["config", "--global", "--get-all", "safe.directory"],
        { env: { ...process.env, LC_ALL: "C" } }
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
      await execFileAsync("git", ["config", "--global", "--add", "safe.directory", normalized], {
        env: { ...process.env, LC_ALL: "C" },
      });
    }
  };
  handlers.push(typedHandle(CHANNELS.GIT_MARK_SAFE_DIRECTORY, handleMarkSafeDirectory));

  return () => handlers.forEach((cleanup) => cleanup());
}
