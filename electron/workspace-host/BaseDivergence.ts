import { join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { getGitDir } from "../utils/gitUtils.js";
import type { StatPrecheck } from "./StatPrecheck.js";

export interface BaseDivergenceResult {
  baseBranchName: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  matchesUpstream: boolean;
}

export interface BaseDivergenceHost {
  readonly branch: string | undefined;
  readonly isMainWorktree: boolean;
  readonly mainBranch: string;
  readonly linkedPrBaseRef: string | undefined;
  readonly path: string;
  readonly wslInvocation: WslGitInvocation | undefined;
  readonly abortSignal: AbortSignal;
}

/** Ahead/behind divergence of the current branch against its base branch. */
export class BaseDivergence {
  private lastKey: string | null = null;
  private lastResult: BaseDivergenceResult | null = null;

  constructor(
    private readonly host: BaseDivergenceHost,
    private readonly statPrecheck: StatPrecheck
  ) {}

  async compute(hasUpstream: boolean): Promise<BaseDivergenceResult | null> {
    const branch = this.host.branch;
    if (!branch || this.host.isMainWorktree) return null;

    // Pick the branch to diff against. A linked PR's base branch is
    // authoritative — it's exactly where this worktree's work will merge,
    // which may differ from the repo's integration branch (e.g. a hotfix
    // PR targeting `main` in a gitflow repo). Without a PR, fall back to
    // the repository's main/integration branch.
    const baseBranch = this.host.linkedPrBaseRef?.trim() || this.host.mainBranch;

    // Divergence only moves when refs move, never on working-tree edits, so
    // a stat key over the involved refs lets forced passes (watcher-driven
    // edit storms) reuse the last result without any git spawns.
    const key = await this.buildKey(branch, baseBranch, hasUpstream);
    if (key !== null && key === this.lastKey) {
      return this.lastResult;
    }

    const wsl = this.host.wslInvocation;
    const git = wsl
      ? await createWslHardenedGit(wsl, this.host.abortSignal)
      : await createHardenedGit(this.host.path, this.host.abortSignal);

    try {
      // Resolve base ref via the rev-list itself: try origin/<branch> first
      // (remote ref stays fresh after fetch), fall back to the local branch
      // for repos without a remote.
      const remoteRef = `origin/${baseBranch}`;
      const localRef = baseBranch;
      const baseBranchName = baseBranch;
      let resolvedRef = remoteRef;
      let result: string;
      try {
        result = await git.raw(["rev-list", "--count", "--left-right", `${remoteRef}...HEAD`]);
      } catch {
        try {
          result = await git.raw(["rev-list", "--count", "--left-right", `${localRef}...HEAD`]);
          resolvedRef = localRef;
        } catch {
          this.lastKey = null;
          return null;
        }
      }
      const trimmed = result.trim();
      const parts = trimmed.split("\t");
      const behindCount = parts[0] != null && parts[0] !== "" ? parseInt(parts[0], 10) : 0;
      const aheadCount = parts[1] != null && parts[1] !== "" ? parseInt(parts[1], 10) : 0;

      let matchesUpstream = false;
      if (hasUpstream) {
        try {
          // One invocation resolves both revs — rev-parse prints one OID per
          // line, and either failing exits non-zero (caught below), matching
          // the previous two-call error semantics.
          const out = await git.raw(["rev-parse", "@{u}", resolvedRef]);
          const [upstreamCommit, baseCommit] = out.trim().split("\n");
          matchesUpstream = baseCommit !== undefined && upstreamCommit.trim() === baseCommit.trim();
        } catch {
          matchesUpstream = false;
        }
      }

      const divergence: BaseDivergenceResult = {
        baseBranchName,
        aheadCount: Number.isFinite(aheadCount) ? aheadCount : null,
        behindCount: Number.isFinite(behindCount) ? behindCount : null,
        matchesUpstream,
      };
      this.lastKey = key;
      this.lastResult = divergence;
      return divergence;
    } catch {
      this.lastKey = null;
      return null;
    }
  }

  /**
   * Stat-derived cache key for `compute`. Covers every ref the computation
   * reads: HEAD, this branch's local ref, the base branch's local and
   * remote refs, the upstream remote ref (the `@{u}` proxy for
   * `matchesUpstream`), and packed-refs. The remote-ref stats are essential —
   * `git fetch` writes loose refs under refs/remotes/ without touching
   * packed-refs, so the stat-baseline fields alone would serve stale
   * behind-of-base counts after background fetches. Returns `null` (compute,
   * don't cache) on any stat failure beyond ENOENT.
   */
  private async buildKey(
    branch: string,
    baseBranch: string,
    hasUpstream: boolean
  ): Promise<string | null> {
    const gitDir = await getGitDir(this.host.path, { cache: true, logErrors: false });
    if (!gitDir) return null;
    try {
      const commonDir = await this.statPrecheck.resolveCommonDirAsync(gitDir);
      const stats = await Promise.all([
        this.statPrecheck.statMtime(pathJoin(gitDir, "HEAD")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "heads", branch)),
        this.statPrecheck.statMtime(pathJoin(commonDir, "packed-refs")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "heads", baseBranch)),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "remotes", "origin", baseBranch)),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "remotes", "origin", branch)),
      ]);
      return [branch, baseBranch, hasUpstream, ...stats].join(" ");
    } catch {
      return null;
    }
  }
}
