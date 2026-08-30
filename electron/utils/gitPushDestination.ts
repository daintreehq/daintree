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
  /**
   * The branch's upstream names a DIFFERENT branch on the one remote this repo
   * has, so `push.default=simple` refuses the push outright and git offers no
   * push ref of its own. The destination above is the same-name branch on that
   * remote — the only one this branch could mean — and the caller must issue
   * the push with an explicit `--set-upstream <remote> <local>:<local>`, which
   * both performs the push and repairs the tracking config that broke it.
   *
   * Main-process-only, like {@link remoteTrackingRef}: it changes how the push
   * is invoked, not what the renderer renders.
   */
  requiresUpstreamRepair?: boolean;
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
const REF_HEADS_PREFIX = "refs/heads/";
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
    // `%(upstream)` rides along for free and is what separates "this branch
    // tracks something differently named" from "this branch tracks nothing" —
    // the two states that both surface as an empty `%(push)`.
    "--format=%(refname)%00%(push:remotename)%00%(push)%00%(upstream)",
    `refs/heads/${branchName}`,
  ]);

  // `refs/heads/topic` as a pattern also matches `refs/heads/topic/sub`, so the
  // record for the branch we asked about has to be picked out by exact refname
  // rather than assumed to be the only one.
  const wanted = `${REF_HEADS_PREFIX}${branchName}`;
  const record = raw
    .split("\n")
    .map((line) => line.split(FIELD_SEPARATOR))
    .find((fields) => fields[0] === wanted);

  if (!record) {
    return { status: "unresolved", reason: "not-configured" };
  }

  // Deliberately NOT trimmed: a remote named " origin" is a different remote
  // from "origin", and normalizing the whitespace away would silently redirect
  // the write to the wrong repository — the exact bug class #11746 is about.
  // The guard below rejects such names outright instead.
  const remote = record[1] ?? "";
  const pushRef = record[2] ?? "";
  const upstreamRef = record[3] ?? "";

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

  // git can name the remote while leaving `%(push)` empty, and an empty push ref
  // does NOT imply the remote-side branch shares the local name:
  //   - `push.default=nothing` deliberately has no default destination at all;
  //   - a `remote.<name>.push` refspec can map `topic` to something else
  //     entirely (a Gerrit `refs/for/topic`, say);
  //   - central `simple` with a differently-named upstream is an error, not a
  //     same-name push.
  // Refuse rather than invent a branch name — the remote alone isn't enough.
  if (!pushRef) {
    return await resolveNameMismatchRepair(git, branchName, remote, remotes, upstreamRef);
  }

  const remoteBranch = stripRemotePrefix(pushRef, remotes);
  if (!remoteBranch) {
    return { status: "unresolved", reason: "invalid-push-ref" };
  }

  return {
    status: "resolved",
    destination: {
      remote,
      branch: remoteBranch,
      // Built from the destination rather than reusing `%(push)`: with
      // `pushRemote=fork` and `push.default=upstream`, git renders the push ref
      // under the FETCH remote (`refs/remotes/origin/...`) while the push goes
      // to `fork`. Leasing or previewing against origin's ref would describe the
      // wrong repository; if this ref doesn't exist locally the lease capture
      // simply fails and the force-push CTA stays suppressed, which is the safe
      // direction.
      remoteTrackingRef: `${REMOTE_TRACKING_PREFIX}${remote}/${remoteBranch}`,
    },
  };
}

/** The one `push.default` value under which the recovery below is git's own intent. */
const SIMPLE_PUSH_DEFAULT = "simple";

/**
 * Recover the destination of a branch whose upstream names a different branch.
 *
 * This is the state `git worktree add -b topic --track origin/develop` leaves
 * behind: `branch.topic.merge` points at `develop`, so under `push.default=simple`
 * git refuses the push ("the upstream branch of your current branch does not
 * match the name of your current branch") and reports a push REMOTE with an
 * empty push REF. Before this, that empty ref fell into `not-configured` and the
 * push button was dead — while the same branch created without any tracking at
 * all pushed happily through {@link resolveUnconfigured}. The more-configured
 * branch was the broken one.
 *
 * Narrow on purpose. Every one of these must hold, or it falls back to refusing:
 *
 *   - the branch really does track something, and that something is a
 *     remote-tracking ref under a known remote carrying a DIFFERENT branch name
 *     (a same-name upstream with an empty push ref is a different fault, and an
 *     untracked branch is {@link resolveUnconfigured}'s case, not this one);
 *   - the repository has exactly one remote and git named that same one, so
 *     "which repository" has a single answer rather than a preferred one;
 *   - `push.default` is unset or `simple`, so the refusal we are recovering
 *     from is the name-mismatch rule and not `nothing`, `matching`, or a
 *     triangular setup;
 *   - no per-remote push refspec exists to map the branch somewhere else.
 *
 * What it infers is only what `simple` itself would have pushed had the names
 * agreed: the same branch name on that remote. The caller still shows the
 * destination in the D2 confirm before anything is written.
 */
async function resolveNameMismatchRepair(
  git: Pick<SimpleGit, "raw">,
  branchName: string,
  remote: string,
  remotes: readonly string[],
  upstreamRef: string
): Promise<GitPushDestinationResolution> {
  const unresolved: GitPushDestinationResolution = {
    status: "unresolved",
    reason: "not-configured",
  };

  if (!upstreamRef) return unresolved;
  if (remotes.length !== 1 || remote !== remotes[0]) return unresolved;

  const upstreamBranch = stripRemotePrefix(upstreamRef, remotes);
  if (!upstreamBranch || upstreamBranch === branchName) return unresolved;

  if (!(await hasDefaultSimplePushConfig(git))) return unresolved;

  return {
    status: "resolved",
    destination: {
      remote,
      branch: branchName,
      remoteTrackingRef: `${REMOTE_TRACKING_PREFIX}${remote}/${branchName}`,
      requiresUpstreamRepair: true,
    },
  };
}

/**
 * True when nothing in the effective config redirects a push away from the
 * plain same-name destination — no `push.default` other than `simple`, and no
 * `remote.<name>.push` refspec.
 *
 * `--list -z` rather than `--get-regexp`: the latter exits non-zero both when
 * nothing matched (the ordinary case) and when the read genuinely failed, and
 * simple-git surfaces the two identically. Reading a real failure as "no
 * overrides" would authorize a push the config had redirected. `--list` exits
 * zero for an empty configuration, so a rejection here is unambiguously a read
 * failure and this fails CLOSED on it: a refused push is a visible prompt to
 * fix the config, a misdirected one is not recoverable.
 *
 * The whole effective config is read, not just the local file, because a
 * global `push.default` governs this push exactly as a local one would.
 */
async function hasDefaultSimplePushConfig(git: Pick<SimpleGit, "raw">): Promise<boolean> {
  let out: string;
  try {
    out = await git.raw(["config", "--list", "-z"]);
  } catch {
    return false;
  }

  // `-z` because a refspec is whitespace-adjacent and a value may span lines:
  // entries are NUL-separated and the key ends at the first newline.
  //
  // Later entries win, exactly as git resolves them, so `push.default` is
  // carried to the end rather than decided on first sight — a repo-local
  // `simple` must be allowed to override a global `current`.
  let pushDefault: string | null = null;
  for (const entry of out.split("\u0000")) {
    if (!entry) continue;
    const newline = entry.indexOf("\n");
    const key = (newline === -1 ? entry : entry.slice(0, newline)).toLowerCase();
    const value = newline === -1 ? "" : entry.slice(newline + 1);
    if (key === "push.default") {
      pushDefault = value.trim();
    } else if (key.startsWith("remote.") && key.endsWith(".push")) {
      return false;
    }
  }
  return pushDefault === null || pushDefault === SIMPLE_PUSH_DEFAULT;
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

/**
 * Resolve where `branchName` pulls FROM — its upstream, not its push target.
 *
 * These are the same ref in the ordinary case and genuinely different in a
 * triangular workflow, where a branch tracks `origin/release/topic` but pushes
 * to `fork/topic`. `git pull` reads the upstream, so a pull-and-rebase that used
 * the push destination would rebase onto a repository the user never asked to
 * integrate from.
 *
 * Fails closed on the same terms as the push resolver.
 */
export async function resolveGitUpstream(
  git: Pick<SimpleGit, "raw" | "getRemotes">,
  branchName: string
): Promise<GitPushDestinationResolution> {
  if (!branchName || branchName === "HEAD") {
    return { status: "unresolved", reason: "not-configured" };
  }

  const remotes = (await git.getRemotes()).map((r) => r.name).filter((n) => n.length > 0);

  const raw = await git.raw([
    "for-each-ref",
    "--format=%(refname)%00%(upstream:remotename)%00%(upstream)",
    `${REF_HEADS_PREFIX}${branchName}`,
  ]);

  const wanted = `${REF_HEADS_PREFIX}${branchName}`;
  const record = raw
    .split("\n")
    .map((line) => line.split(FIELD_SEPARATOR))
    .find((fields) => fields[0] === wanted);

  if (!record) return { status: "unresolved", reason: "not-configured" };

  const remote = record[1] ?? "";
  const upstreamRef = record[2] ?? "";

  if (!remote || !upstreamRef) {
    return { status: "unresolved", reason: "not-configured" };
  }
  if (!isSafeRemoteName(remote)) {
    return { status: "unresolved", reason: "unsafe-remote" };
  }
  if (!remotes.includes(remote)) {
    return { status: "unresolved", reason: "invalid-push-ref" };
  }

  const remoteBranch = stripRemotePrefix(upstreamRef, remotes);
  if (!remoteBranch) {
    return { status: "unresolved", reason: "invalid-push-ref" };
  }

  return {
    status: "resolved",
    destination: {
      remote,
      branch: remoteBranch,
      remoteTrackingRef: `${REMOTE_TRACKING_PREFIX}${remote}/${remoteBranch}`,
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

/**
 * Message text for an upstream that could not be resolved, by reason.
 *
 * Deliberately not shared with the push wording: a pull-and-rebase that fails
 * for want of an upstream must not tell the user to configure a push remote
 * (#11746). Both land in the `config-missing` bucket, so the renderer's
 * recovery hint still applies.
 */
export function describeUnresolvedUpstream(
  reason: GitPushDestinationUnresolvedReason,
  branchName: string
): string {
  switch (reason) {
    case "unsafe-remote":
      return `fatal: the remote configured for branch '${branchName}' has an unusable name`;
    case "invalid-push-ref":
      return `fatal: could not resolve the upstream for branch '${branchName}'`;
    case "ambiguous":
    case "not-configured":
    default:
      return `fatal: no upstream configured for branch '${branchName}'`;
  }
}
