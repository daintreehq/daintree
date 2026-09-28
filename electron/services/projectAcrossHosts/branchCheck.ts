import type { SimpleGit } from "simple-git";
import type { BranchCheck } from "../../../shared/types/ipc/hostSwitch.js";
import { readRemoteBranchTip } from "../../utils/remoteBranchTip.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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
  /** The branch's name on `check.remote` (its upstream's name, else its own). */
  remoteBranch: string | null;
  /** The remote the branch lives on, or would be pushed to. */
  remote: string | null;
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
 * Ask the remote itself where the checked-out branch is and compare commit
 * ids. Upstream ahead/behind counts only compare against the local tracking
 * ref, which can be stale; this can't be.
 */
export async function checkBranchAgainstRemote(
  input: BranchCheckInput
): Promise<BranchCheckResult> {
  const { git, networkGit, remotes } = input;
  const head = (await tryRaw(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() ?? "";
  if (head.length === 0) {
    return { branch: null, check: { kind: "detached" }, remoteBranch: null, remote: null };
  }
  const branch = head;
  const upstreamRemote = await readConfigValue(git, `branch.${branch}.remote`);
  const upstreamMerge = await readConfigValue(git, `branch.${branch}.merge`);
  const upstreamBranch = upstreamMerge?.replace(/^refs\/heads\//, "") ?? null;
  const upstream =
    upstreamRemote && upstreamBranch ? `${upstreamRemote}/${upstreamBranch}` : upstreamRemote;
  const remote = pickRemote(upstreamRemote, remotes);
  if (!remote) {
    return {
      branch,
      check: { kind: "not-on-remote", remote: null, upstream },
      remoteBranch: null,
      remote: null,
    };
  }
  const remoteBranch = upstreamRemote === remote && upstreamBranch ? upstreamBranch : branch;
  const base = { branch, remoteBranch, remote };

  const tip = await readRemoteBranchTip(networkGit, remote, remoteBranch, input.tipTimeoutMs);
  if (tip === undefined) {
    return { ...base, check: { kind: "remote-unreachable", remote, detail: null } };
  }
  if (tip === null) {
    return { ...base, check: { kind: "not-on-remote", remote, upstream } };
  }
  const local = (await tryRaw(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]))?.trim();
  if (!local) {
    return { ...base, check: { kind: "not-on-remote", remote, upstream } };
  }
  if (local.toLowerCase() === tip.toLowerCase()) {
    return { ...base, check: { kind: "same-tip", remote, sha: tip } };
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
        check: {
          kind: "remote-unreachable",
          remote,
          detail: scrubSecrets(formatErrorMessage(error, "git fetch failed")),
        },
      };
    }
    if (!(await hasCommit(git, tip))) {
      return { ...base, check: { kind: "remote-unreachable", remote, detail: null } };
    }
  }

  const ahead = await countCommits(git, `${tip}..HEAD`);
  const behind = await countCommits(git, `HEAD..${tip}`);
  if (ahead === null || behind === null) {
    return { ...base, check: { kind: "remote-unreachable", remote, detail: null } };
  }
  if (ahead > 0 && behind > 0) return { ...base, check: { kind: "diverged", remote } };
  if (ahead > 0) return { ...base, check: { kind: "ahead", remote, ahead } };
  return { ...base, check: { kind: "behind", remote, behind, sha: tip } };
}
