import { join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { getGitDir } from "../utils/gitUtils.js";
import { resolveBaseCompareRef } from "../../shared/utils/baseRemoteSelection.js";
import type { StatPrecheck } from "./StatPrecheck.js";

/**
 * Ceiling on how long a cached remote resolution may be reused while its stat
 * stamp looks unchanged. The stamp covers the mutations that matter (config
 * writes, packed-refs, the candidate refs themselves), but a stat set is a
 * fixed set — anything outside it changes invisibly, exactly the failure class
 * #10956 fixed for the status pre-check. `git remote add upstream` followed by
 * a fetch that only touches a nested `refs/remotes/upstream/release/` directory
 * is the concrete case. The ceiling bounds every such miss to one interval
 * instead of forever, for the cost of a handful of local git spawns per
 * worktree per interval.
 */
const RESOLUTION_MAX_AGE_MS = 5 * 60_000;

const REMOTE_REF_PREFIX = "refs/remotes/";

interface BaseDivergenceResult {
  baseBranchName: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  matchesUpstream: boolean;
  /**
   * The ref the counts were actually measured against — `upstream/main`, or a
   * bare `main` when we fell back to the local branch. Surfaced so the badge
   * tooltip can name it: on the multi-remote layouts this resolution can still
   * get wrong, naming the ref turns a silently wrong number into an obviously
   * wrong one (#11747).
   */
  baseCompareRef: string | null;
  /**
   * Remote `baseCompareRef` lives on, or `null` on the local fallback. Read by
   * `WorkspaceService` to decide which remotes background fetch must refresh —
   * resolving the right ref but never fetching it is just a slower way to be
   * stale.
   */
  baseRemote: string | null;
}

/** Cached output of the (spawning) remote-resolution step. */
interface RemoteResolution {
  /** Short ref to diff against (`upstream/main`), or null to use the fallback chain. */
  compareRef: string | null;
  /** Remote `compareRef` lives on. */
  remote: string | null;
  /** Full ref `@{u}` resolves to, so `buildKey` stats the ref that actually moves. */
  upstreamRef: string | null;
  /** `git remote` output, cached so the stat stamp can cover each candidate ref. */
  availableRemotes: readonly string[];
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

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

type GitRunner = { raw(args: string[]): Promise<string> };

/** Ahead/behind divergence of the current branch against its base branch. */
export class BaseDivergence {
  private lastKey: string | null = null;
  private lastResult: BaseDivergenceResult | null = null;

  private resolutionStamp: string | null = null;
  private resolution: RemoteResolution | null = null;
  private resolutionAt = 0;

  constructor(
    private readonly host: BaseDivergenceHost,
    private readonly statPrecheck: StatPrecheck
  ) {}

  /**
   * Remote the divergence *wants* to compare against — the resolution's answer,
   * not whichever ref the last pass happened to succeed against.
   *
   * The distinction is load-bearing. A `rev-list upstream/main...HEAD` that
   * fails because `upstream/main` hasn't been fetched yet falls back to the
   * local branch and records `baseRemote: null` on the result. Reporting that
   * null here would drop `upstream` from the fetch plan, so the ref would never
   * arrive, so the stat key would never move, so the fallback result would be
   * served from cache forever — a deadlock that bites exactly the fresh-fork
   * setup this issue is about. Reporting the resolved remote keeps it in the
   * fetch plan until it succeeds.
   */
  get baseRemote(): string | null {
    return this.resolution?.remote ?? null;
  }

  /** Remotes this repo has, as of the last resolution. Empty until one runs. */
  get availableRemotes(): readonly string[] {
    return this.resolution?.availableRemotes ?? [];
  }

  async compute(hasUpstream: boolean): Promise<BaseDivergenceResult | null> {
    const branch = this.host.branch;
    if (!branch || this.host.isMainWorktree) return null;

    // Pick the branch to diff against. A linked PR's base branch is
    // authoritative — it's exactly where this worktree's work will merge,
    // which may differ from the repo's integration branch (e.g. a hotfix
    // PR targeting `main` in a gitflow repo). Without a PR, fall back to
    // the repository's main/integration branch.
    const baseBranch = this.host.linkedPrBaseRef?.trim() || this.host.mainBranch;

    const dirs = await this.resolveDirs();

    // Which remote holds the base branch is a git-config question, so it must
    // not be asked on every poll. It's cached behind its own stat stamp and
    // only re-derived when that stamp moves (or ages out), which keeps the
    // key-matched fast path below entirely spawn-free.
    const resolution = dirs
      ? await this.resolveRemotes(branch, baseBranch, hasUpstream, dirs)
      : null;

    // Divergence only moves when refs move, never on working-tree edits, so
    // a stat key over the involved refs lets forced passes (watcher-driven
    // edit storms) reuse the last result without any git spawns.
    const key = dirs
      ? await this.buildKey(branch, baseBranch, hasUpstream, dirs, resolution)
      : null;
    if (key !== null && key === this.lastKey) {
      return this.lastResult;
    }

    const git = await this.createGit();

    try {
      // Resolve base ref via the rev-list itself: try the resolved remote ref
      // first (remote refs stay fresh after fetch), fall back to the local
      // branch for repos without a remote. `origin/<base>` remains the
      // pre-resolution default, so a repo whose remote can't be resolved
      // behaves exactly as it did before #11747.
      const remoteRef = resolution?.compareRef ?? `origin/${baseBranch}`;
      const remoteName = resolution?.compareRef ? resolution.remote : null;
      const localRef = baseBranch;
      const baseBranchName = baseBranch;
      let resolvedRef = remoteRef;
      let resolvedRemote = remoteName;
      let result: string;
      try {
        result = await git.raw(["rev-list", "--count", "--left-right", `${remoteRef}...HEAD`]);
      } catch {
        try {
          result = await git.raw(["rev-list", "--count", "--left-right", `${localRef}...HEAD`]);
          resolvedRef = localRef;
          resolvedRemote = null;
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
        baseCompareRef: resolvedRef,
        baseRemote: resolvedRemote,
      };
      this.lastKey = key;
      this.lastResult = divergence;
      return divergence;
    } catch {
      this.lastKey = null;
      return null;
    }
  }

  private async createGit(): Promise<GitRunner> {
    const wsl = this.host.wslInvocation;
    return wsl
      ? await createWslHardenedGit(wsl, this.host.abortSignal)
      : await createHardenedGit(this.host.path, this.host.abortSignal);
  }

  private async resolveDirs(): Promise<GitDirs | null> {
    const gitDir = await getGitDir(this.host.path, { cache: true, logErrors: false });
    if (!gitDir) return null;
    try {
      const commonDir = await this.statPrecheck.resolveCommonDirAsync(gitDir);
      return { gitDir, commonDir };
    } catch {
      return null;
    }
  }

  /**
   * Resolve (and cache) which remote ref the base branch should be compared
   * against. Spawns git, so it runs only when the stat stamp moves or the
   * cached answer ages past {@link RESOLUTION_MAX_AGE_MS} — on a steady poll
   * loop it never spawns at all.
   */
  private async resolveRemotes(
    branch: string,
    baseBranch: string,
    hasUpstream: boolean,
    dirs: GitDirs
  ): Promise<RemoteResolution | null> {
    const stamp = await this.buildResolutionStamp(branch, baseBranch, hasUpstream, dirs);
    // The age ceiling only earns its spawns where the answer is genuinely
    // ambiguous. With at most one remote there is nothing to choose between,
    // and anything that could introduce a second one writes `.git/config`,
    // which the stamp already covers — so the overwhelmingly common repo
    // re-resolves on real events only, never on a timer.
    const ambiguous = (this.resolution?.availableRemotes.length ?? 0) > 1;
    const aged = ambiguous && Date.now() - this.resolutionAt >= RESOLUTION_MAX_AGE_MS;
    // A null stamp means a stat failed unexpectedly. Re-resolving on every such
    // poll would turn a flaky filesystem into a spawn storm, so the cached
    // answer is held until it ages out on its own.
    if (this.resolution !== null && !aged && (stamp === null || stamp === this.resolutionStamp)) {
      return this.resolution;
    }

    const git = await this.createGit();
    const availableRemotes = await this.readRemotes(git);
    const trackedRef = await this.readSymbolicRef(git, `${baseBranch}@{upstream}`);
    const remotesWithBaseRef = trackedRef
      ? []
      : await this.readRemotesCarrying(git, baseBranch, availableRemotes);
    const upstreamRef = hasUpstream ? await this.readSymbolicRef(git, "@{u}") : null;

    const { compareRef, remote } = resolveBaseCompareRef({
      baseBranch,
      trackedRef,
      remotesWithBaseRef,
      availableRemotes,
    });

    this.resolution = { compareRef, remote, upstreamRef, availableRemotes };
    this.resolutionAt = Date.now();
    // Re-derive the stamp: the first resolution discovers the remote names the
    // stamp's candidate-ref stats are built from, so the stamp computed before
    // resolving covered fewer paths than the one that must match next poll.
    this.resolutionStamp = await this.buildResolutionStamp(branch, baseBranch, hasUpstream, dirs);
    return this.resolution;
  }

  /** `git remote` — names only, no URLs, no network. */
  private async readRemotes(git: GitRunner): Promise<string[]> {
    try {
      const out = await git.raw(["remote"]);
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Resolve a revision to its full symbolic ref. Returns `null` when the
   * revision has no upstream (git exits non-zero), which is the normal case
   * for an unpushed branch.
   */
  private async readSymbolicRef(git: GitRunner, rev: string): Promise<string | null> {
    try {
      const out = await git.raw(["rev-parse", "--symbolic-full-name", rev]);
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * Which remotes carry `<baseBranch>`. Uses `for-each-ref` rather than a
   * readdir so packed refs are found too.
   *
   * One literal pattern per known remote rather than a single
   * `refs/remotes/*` glob: git's ref-filter wildcard does not cross `/`, so a
   * remote whose own name contains a slash (`team/fork`) would never appear in
   * the glob's output, and the exact cross-reference below cannot recover a ref
   * that was never listed.
   */
  private async readRemotesCarrying(
    git: GitRunner,
    baseBranch: string,
    availableRemotes: readonly string[]
  ): Promise<string[]> {
    if (availableRemotes.length === 0) return [];
    try {
      const out = await git.raw([
        "for-each-ref",
        "--format=%(refname)",
        "--",
        ...availableRemotes.map((remote) => `${REMOTE_REF_PREFIX}${remote}/${baseBranch}`),
      ]);
      const found: string[] = [];
      for (const line of out.split("\n")) {
        const ref = line.trim();
        if (!ref.startsWith(REMOTE_REF_PREFIX)) continue;
        const shortRef = ref.slice(REMOTE_REF_PREFIX.length);
        // Remote names may contain `/`, so match against the known names
        // rather than splitting on the first separator.
        for (const remote of availableRemotes) {
          if (shortRef === `${remote}/${baseBranch}` && !found.includes(remote)) {
            found.push(remote);
          }
        }
      }
      return found;
    } catch {
      return [];
    }
  }

  /**
   * Stat stamp gating the (spawning) remote resolution. Covers the effective
   * config files — `commonDir/config` is the shared one, and
   * `gitDir/config.worktree` carries per-worktree overrides when
   * `extensions.worktreeConfig` is on, so `branch.<base>.remote` can differ
   * per worktree — plus packed-refs and each known remote's candidate ref, so
   * a newly fetched base ref re-opens the question. `branch`/`baseBranch` are
   * part of the identity: a PR relink changes `linkedPrBaseRef` without
   * touching any file, and reusing the previous base's remote would compare
   * against the wrong ref entirely.
   */
  private async buildResolutionStamp(
    branch: string,
    baseBranch: string,
    hasUpstream: boolean,
    dirs: GitDirs
  ): Promise<string | null> {
    const { gitDir, commonDir } = dirs;
    try {
      const candidatePaths = (this.resolution?.availableRemotes ?? []).map((remote) =>
        pathJoin(commonDir, "refs", "remotes", ...remote.split("/"), ...baseBranch.split("/"))
      );
      const stats = await Promise.all([
        this.statPrecheck.statMtime(pathJoin(commonDir, "config")),
        this.statPrecheck.statMtime(pathJoin(gitDir, "config.worktree")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "packed-refs")),
        ...candidatePaths.map((path) => this.statPrecheck.statMtime(path)),
      ]);
      return [branch, baseBranch, hasUpstream, ...stats].join(" ");
    } catch {
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
   * behind-of-base counts after background fetches. Both remote paths follow
   * the resolved refs rather than assuming `origin`, and the resolved compare
   * ref is part of the key so a resolution flip invalidates the cached counts.
   * Returns `null` (compute, don't cache) on any stat failure beyond ENOENT.
   */
  private async buildKey(
    branch: string,
    baseBranch: string,
    hasUpstream: boolean,
    dirs: GitDirs,
    resolution: RemoteResolution | null
  ): Promise<string | null> {
    const { gitDir, commonDir } = dirs;
    try {
      const compareRefPath = resolution?.compareRef
        ? pathJoin(commonDir, "refs", "remotes", ...resolution.compareRef.split("/"))
        : pathJoin(commonDir, "refs", "remotes", "origin", ...baseBranch.split("/"));
      const upstreamRefPath = resolution?.upstreamRef
        ? pathJoin(commonDir, ...resolution.upstreamRef.split("/"))
        : pathJoin(commonDir, "refs", "remotes", "origin", ...branch.split("/"));
      const stats = await Promise.all([
        this.statPrecheck.statMtime(pathJoin(gitDir, "HEAD")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "heads", ...branch.split("/"))),
        this.statPrecheck.statMtime(pathJoin(commonDir, "packed-refs")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "refs", "heads", ...baseBranch.split("/"))),
        this.statPrecheck.statMtime(compareRefPath),
        this.statPrecheck.statMtime(upstreamRefPath),
      ]);
      return [branch, baseBranch, hasUpstream, resolution?.compareRef ?? "", ...stats].join(" ");
    } catch {
      return null;
    }
  }
}
