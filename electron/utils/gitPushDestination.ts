import type { SimpleGit } from "simple-git";
import type { GitPushDestination } from "../../shared/types/git.js";

/**
 * A push destination git itself resolved, plus the remote-tracking ref that
 * goes with it. `remoteTrackingRef` stays main-process-only: it is an
 * implementation detail of lease capture and the discard preview, not
 * something a renderer should render or round-trip.
 */
export interface ResolvedGitPushDestination extends GitPushDestination {
  /** Full ref, e.g. `refs/remotes/fork/release/topic`. */
  remoteTrackingRef: string;
}

export type GitPushDestinationResolution =
  | { status: "resolved"; destination: ResolvedGitPushDestination }
  | { status: "unresolved"; reason: GitPushDestinationUnresolvedReason };

export type GitPushDestinationUnresolvedReason =
  /** Nothing configured, and the repository has no remote to fall back on. */
  | "not-configured"
  /** Several remotes exist and no config says which one this branch pushes to. */
  | "ambiguous"
  /** The configured remote name could be smuggled into argv as a flag. */
  | "unsafe-remote"
  /** git answered, but not in a shape we can safely take apart. */
  | "invalid-push-ref";

const REMOTE_TRACKING_PREFIX = "refs/remotes/";
/**
 * NUL, via git's own `%00` format escape. A space would be ambiguous against
 * any value that could contain one — and the argv guard below exists precisely
 * to reject such values, so the parse must not lose them first.
 */
const FIELD_SEPARATOR = "\u0000";

/**
 * Remote names that could be read as argv flags, or that carry whitespace or
 * control characters, never reach a git invocation. Mirrors the lease-SHA guard
 * in `git-write.ts`: a remote name is config-derived, and config is not a
 * trusted input when its value lands in an argv position. Slashes are
 * deliberately allowed — `git remote add team/fork <url>` is legal.
 */
function isSafeRemoteName(name: string): boolean {
  if (!name || name.startsWith("-")) return false;
  for (const char of name) {
    const code = char.codePointAt(0)!;
    // C0 (including tab and newline), space, DEL, and C1.
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Strip `refs/remotes/<remote>/` using the LONGEST remote name that matches,
 * so a repo holding both `team` and `team/fork` resolves
 * `refs/remotes/team/fork/topic` to the branch `topic` rather than `fork/topic`.
 */
function stripRemotePrefix(fullRef: string, remotes: readonly string[]): string | null {
  if (!fullRef.startsWith(REMOTE_TRACKING_PREFIX)) return null;
  const withoutPrefix = fullRef.slice(REMOTE_TRACKING_PREFIX.length);
  const candidates = [...remotes].sort((a, b) => b.length - a.length);
  for (const remote of candidates) {
    if (withoutPrefix.startsWith(`${remote}/`)) {
      const branch = withoutPrefix.slice(remote.length + 1);
      return branch.length > 0 ? branch : null;
    }
  }
  return null;
}

/**
 * Resolve where `branchName` actually pushes, using git's own answer.
 *
 * Fixes #11746: every git write path used to hardcode `origin`, so a branch
 * configured to push to a fork silently wrote to the wrong repository.
 *
 * The whole precedence chain (`branch.<n>.pushRemote` → `remote.pushDefault` →
 * `branch.<n>.remote`) is git's to evaluate, not ours — `%(push:remotename)`
 * reports the result of it, including for a branch carrying no config of its
 * own beyond a repo-level `remote.pushDefault`. Re-deriving that chain from
 * `getConfig()` would duplicate git's handling of `push.default`, push
 * refspecs, and triangular workflows, and would reintroduce the
 * `ConfigGetResult` envelope hazard that already bit `PullRequestService`.
 *
 * `for-each-ref` rather than `rev-parse --abbrev-ref <branch>@{push}`: the
 * revparse form fails with "ambiguous argument" when the remote-tracking ref
 * has not been fetched yet, even though the tracking config is present and
 * correct — which is the normal state of a freshly created worktree branch.
 *
 * The remote name comes from `%(push:remotename)` and the branch from `%(push)`,
 * because the two can legitimately disagree: with `branch.<n>.pushRemote=fork`
 * and `push.default=upstream`, git reports remotename `fork` while the push ref
 * itself renders under the *fetch* remote as `refs/remotes/origin/release/topic`.
 * Reading the branch off `%(push:short)` by stripping the remote name would call
 * that correctly-configured repo unresolvable.
 *
 * Fails CLOSED. When git has no answer and the remote table cannot supply an
 * unambiguous one, this returns `unresolved` rather than substituting `origin`
 * — sending a write to a repository the user did not choose is not recoverable,
 * while a blocked button is a visible prompt to configure a remote.
 */
export async function resolveGitPushDestination(
  git: Pick<SimpleGit, "raw" | "getRemotes">,
  branchName: string
): Promise<GitPushDestinationResolution> {
  if (!branchName || branchName === "HEAD") {
    return { status: "unresolved", reason: "not-configured" };
  }

  const remotes = (await git.getRemotes()).map((r) => r.name).filter((n) => n.length > 0);

  const raw = await git.raw([
    "for-each-ref",
    "--format=%(push:remotename)%00%(push)",
    `refs/heads/${branchName}`,
  ]);

  const [remoteField = "", pushRefField = ""] = raw.trim().split(FIELD_SEPARATOR);
  const remote = remoteField.trim();
  const pushRef = pushRefField.trim();

  if (!remote) {
    return resolveUnconfigured(remotes, branchName);
  }
  if (!isSafeRemoteName(remote)) {
    return { status: "unresolved", reason: "unsafe-remote" };
  }
  // A remote git names must be a remote git knows: an entry that vanished from
  // the remote table between config and now is not a destination we can push to.
  if (!remotes.includes(remote)) {
    return { status: "unresolved", reason: "invalid-push-ref" };
  }

  // git can name the remote while leaving `%(push)` empty — notably under the
  // default `push.default=simple` with a `pushRemote` that differs from the
  // fetch remote, where git's documented behaviour is to act like `current` and
  // push to the same-named branch. The repository is still git's own answer,
  // which is the axis #11746 is about; only the branch component is unstated,
  // and same-name is the rule git itself applies there.
  if (!pushRef) {
    return {
      status: "resolved",
      destination: {
        remote,
        branch: branchName,
        remoteTrackingRef: `${REMOTE_TRACKING_PREFIX}${remote}/${branchName}`,
      },
    };
  }

  const remoteBranch = stripRemotePrefix(pushRef, remotes);
  if (!remoteBranch) {
    return { status: "unresolved", reason: "invalid-push-ref" };
  }

  return {
    status: "resolved",
    destination: { remote, branch: remoteBranch, remoteTrackingRef: pushRef },
  };
}

/**
 * A branch with no push configuration at all — the state every freshly created
 * worktree branch starts in, where git's own `git push` refuses and tells you to
 * pick a remote.
 *
 * One remote is not a guess: it is the only destination the repository has, and
 * the D2 confirm renders it for approval before anything is written. Two or more
 * is a real ambiguity, and picking `origin` by name there is precisely the bug
 * #11746 reports — so it fails closed even when an `origin` exists.
 */
function resolveUnconfigured(
  remotes: readonly string[],
  branchName: string
): GitPushDestinationResolution {
  if (remotes.length !== 1) {
    return { status: "unresolved", reason: remotes.length === 0 ? "not-configured" : "ambiguous" };
  }
  const remote = remotes[0]!;
  if (!isSafeRemoteName(remote)) {
    return { status: "unresolved", reason: "unsafe-remote" };
  }
  return {
    status: "resolved",
    destination: {
      remote,
      branch: branchName,
      remoteTrackingRef: `${REMOTE_TRACKING_PREFIX}${remote}/${branchName}`,
    },
  };
}

/** Human-facing `remote/branch`, for confirm previews and progress labels. */
export function formatGitPushDestination(destination: GitPushDestination): string {
  return `${destination.remote}/${destination.branch}`;
}

/** Message text for a destination that could not be resolved, by reason. */
export function describeUnresolvedPushDestination(
  reason: GitPushDestinationUnresolvedReason,
  branchName: string
): string {
  switch (reason) {
    case "ambiguous":
      return `fatal: no push destination configured for branch '${branchName}' and this repository has several remotes — set branch.${branchName}.pushRemote or remote.pushDefault`;
    case "unsafe-remote":
      return `fatal: the remote configured for branch '${branchName}' has an unusable name`;
    case "invalid-push-ref":
      return `fatal: could not resolve the push destination for branch '${branchName}'`;
    case "not-configured":
    default:
      return `fatal: no push destination configured for branch '${branchName}'`;
  }
}
