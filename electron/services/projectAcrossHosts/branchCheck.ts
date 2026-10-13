import type { SimpleGit } from "simple-git";
import type { BranchCheck } from "../../../shared/types/ipc/hostSwitch.js";
import { readRemoteBranchTip } from "../../utils/remoteBranchTip.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { resolveGitPushAndUpstream } from "../../utils/gitPushDestination.js";
import { countCommits, hasCommit, readConfigValue, tryRaw } from "./gitOps.js";

type Git = Pick<SimpleGit, "raw">;

export interface BranchCheckInput {
  /** Reads the working tree's own state. */
  git: Git;
  /** Asks the remote (ls-remote, fetch) with this machine's credentials. */
  networkGit: Git;
  remotes: Array<{ name: string; url: string }>;
  tipTimeoutMs?: number;
}

export interface BranchCheckResult {
  branch: string | null;
  check: BranchCheck;
  /**
   * The branch's name on `check.remote`: always its own name. Never its
   * upstream's, which for a topic branched off `origin/develop` is `develop`.
   */
  remoteBranch: string | null;
  /** The remote the branch lives on, or would be pushed to. */
  remote: string | null;
  /**
   * Where git itself would push the branch, when that is the same-named
   * branch on one remote. Null when git has no such destination (nothing
   * configured, several remotes, an upstream naming a different branch,
   * `push.default` of nothing or matching): no push is offered then.
   */
  pushDestination: { remote: string; branch: string } | null;
  /** The commit checked out here, or null when there is none (detached is still a commit). */
  headSha: string | null;
  /** The remote branch's tip as the remote reported it, when it has one. */
  remoteTip: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * The branch's remote, in git's own order: its upstream's remote when that
 * remote exists, else `origin`, else the repository's only remote. Never a
 * guess among several.
 */
function pickRemote(
  upstreamRemote: string | null,
  remotes: Array<{ name: string }>
): string | null {
  if (upstreamRemote && remotes.some((r) => r.name === upstreamRemote)) return upstreamRemote;
  if (remotes.some((r) => r.name === "origin")) return "origin";
  return remotes.length === 1 ? remotes[0]!.name : null;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Git's own push destination for `branch`, kept only when it is the branch
 * of the same name: a push is never aimed at another branch, and never
 * guessed when git has no answer.
 */
export async function resolveSameNamePush(
  git: Git,
  branch: string,
  remotes: Array<{ name: string }>
): Promise<{ remote: string; branch: string } | null> {
  const names = remotes.map((r) => r.name);
  const reader = {
    raw: (args: string[]) => git.raw(args),
    getRemotes: async () => names.map((name) => ({ name, refs: { fetch: "", push: "" } })),
  } as unknown as Parameters<typeof resolveGitPushAndUpstream>[0];
  try {
    const { push } = await resolveGitPushAndUpstream(reader, branch, names);
    if (push.status !== "resolved") return null;
    const { destination } = push;
    if (destination.requiresUpstreamRepair || destination.branch !== branch) return null;
    // With nothing configured the resolver falls back to the only remote;
    // that is only git's own answer when no setting says otherwise.
    const pushDefault = (await readConfigValue(git, "push.default"))?.toLowerCase() ?? null;
    if (pushDefault === "nothing" || pushDefault === "matching") return null;
    const refspecs = await tryRaw(git, [
      "config",
      "--get-all",
      `remote.${destination.remote}.push`,
    ]);
    if ((refspecs ?? "").trim().length > 0) return null;
    // Under `push.default=current` git would push a topic that tracks
    // `develop` to `topic`; tracking another branch still means the person
    // set it up to land somewhere else, so it isn't pushed from here.
    const merge = await readConfigValue(git, `branch.${branch}.merge`);
    if (merge !== null && merge !== `refs/heads/${branch}`) return null;
    return { remote: destination.remote, branch };
  } catch {
    return null;
  }
}

/**
 * Ask the remote itself where the checked-out branch is and compare commit
 * ids. Upstream ahead/behind counts only compare against the local tracking
 * ref, which can be stale; this can't be.
 */
export async function checkBranchAgainstRemote(
  input: BranchCheckInput
): Promise<BranchCheckResult> {
  const { git, networkGit, remotes } = input;
  const head = (await tryRaw(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() ?? "";
  const local =
    (await tryRaw(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.trim() || null;
  const none = { remoteBranch: null, remote: null, pushDestination: null, remoteTip: null };
  if (head.length === 0) {
    return { branch: null, check: { kind: "detached" }, headSha: local, ...none };
  }
  const branch = head;
  const upstreamRemote = await readConfigValue(git, `branch.${branch}.remote`);
  const upstreamMerge = await readConfigValue(git, `branch.${branch}.merge`);
  const upstreamBranch = upstreamMerge?.replace(/^refs\/heads\//, "") ?? null;
  const upstream =
    upstreamRemote && upstreamBranch ? `${upstreamRemote}/${upstreamBranch}` : upstreamRemote;
  const pushDestination = await resolveSameNamePush(git, branch, remotes);
  const remote = pushDestination?.remote ?? pickRemote(upstreamRemote, remotes);
  if (!remote) {
    return {
      branch,
      check: { kind: "not-on-remote", remote: null, upstream },
      headSha: local,
      ...none,
    };
  }
  const remoteBranch = branch;
  const base = { branch, remoteBranch, remote, pushDestination, headSha: local };

  const tip = await readRemoteBranchTip(networkGit, remote, remoteBranch, input.tipTimeoutMs);
  if (tip === undefined) {
    return {
      ...base,
      remoteTip: null,
      check: { kind: "remote-unreachable", remote, detail: null },
    };
  }
  if (tip === null) {
    return { ...base, remoteTip: null, check: { kind: "not-on-remote", remote, upstream } };
  }
  if (!local) {
    return { ...base, remoteTip: tip, check: { kind: "not-on-remote", remote, upstream } };
  }
  if (local.toLowerCase() === tip.toLowerCase()) {
    return { ...base, remoteTip: tip, check: { kind: "same-tip", remote, sha: tip } };
  }

  if (!(await hasCommit(git, tip))) {
    // The remote moved past anything fetched here. Fetch just that ref so the
    // comparison is made on commits, not guessed from their absence.
    try {
      await withTimeout(
        networkGit.raw([
          "fetch",
          "--no-tags",
          "--quiet",
          "--",
          remote,
          `refs/heads/${remoteBranch}`,
        ]),
        FETCH_TIMEOUT_MS
      );
    } catch (error) {
      return {
        ...base,
        remoteTip: tip,
        check: {
          kind: "remote-unreachable",
          remote,
          detail: scrubSecrets(formatErrorMessage(error, "git fetch failed")),
        },
      };
    }
    if (!(await hasCommit(git, tip))) {
      return {
        ...base,
        remoteTip: tip,
        check: { kind: "remote-unreachable", remote, detail: null },
      };
    }
  }

  // The commit already read, not HEAD again: what is counted is what is shown and pushed.
  const ahead = await countCommits(git, `${tip}..${local}`);
  const behind = await countCommits(git, `${local}..${tip}`);
  if (ahead === null || behind === null) {
    return { ...base, remoteTip: tip, check: { kind: "remote-unreachable", remote, detail: null } };
  }
  if (ahead > 0 && behind > 0)
    return { ...base, remoteTip: tip, check: { kind: "diverged", remote } };
  if (ahead > 0) return { ...base, remoteTip: tip, check: { kind: "ahead", remote, ahead } };
  return { ...base, remoteTip: tip, check: { kind: "behind", remote, behind, sha: tip } };
}
