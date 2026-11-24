import { join as pathJoin } from "path";
import { createHardenedGit, createWslHardenedGit } from "../utils/hardenedGit.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { getGitDir } from "../utils/gitUtils.js";
import { readSymbolicRef } from "../utils/baseCompareRef.js";
import { RESOLUTION_MAX_AGE_MS, SharedBaseRefResolver } from "./SharedBaseRefResolver.js";
import type { StatPrecheck } from "./StatPrecheck.js";

// A configured upstream whose ref didn't resolve (not fetched yet, or deleted
// on the remote) comes back by writing only that ref, which the stamp doesn't
// cover, so it is asked again on a clock instead: soon at first, backing off to
// the age ceiling for one that stays gone.
const UNRESOLVED_UPSTREAM_RETRY_MIN_MS = 30_000;

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
  /** Full ref `@{u}` resolves to (`refs/remotes/origin/feature/x`), or null without one. */
  upstreamRef: string | null;
  /**
   * Commit `@{u}` points at. It moves when a push completes or a fetch picks up
   * one made elsewhere, and never on a local commit, so it is the PR service's
   * quota-free signal that the PR's head moved (#13400).
   */
  upstreamHeadSha: string | null;
}

/** The remote-resolution step's answer: the shared base selection plus this worktree's `@{u}`. */
interface RemoteResolution {
  /** Short ref to diff against (`upstream/main`), or null to use the fallback chain. */
  compareRef: string | null;
  /** Remote `compareRef` lives on. */
  remote: string | null;
  /** Full ref `@{u}` resolves to, so `buildKey` stats the ref that actually moves. */
  upstreamRef: string | null;
  /** `git remote` output, cached so the stat stamp can cover each candidate ref. */
  availableRemotes: readonly string[];
  /** Whether an empty `availableRemotes` came from a successful `git remote`. */
  remotesReadSucceeded: boolean;
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

  private resolution: RemoteResolution | null = null;

  private upstreamRead = false;
  private upstream: string | null = null;
  private upstreamStamp: string | null = null;
  private upstreamAt = 0;
  private unresolvedUpstreamRetryMs = UNRESOLVED_UPSTREAM_RETRY_MIN_MS;

  /**
   * `sharedBase` is the workspace service's, so linked worktrees of one
   * repository resolve the base ref once between them. The default keeps a
   * standalone instance to itself.
   */
  constructor(
    private readonly host: BaseDivergenceHost,
    private readonly statPrecheck: StatPrecheck,
    private readonly sharedBase: SharedBaseRefResolver = new SharedBaseRefResolver()
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

  /** Full ref `@{u}` resolves to, as of the last resolution. */
  get upstreamRef(): string | null {
    return this.resolution?.upstreamRef ?? null;
  }

  /**
   * `signal` stops this computation's git: the status pass passes its own, so
   * a pass the watchdog gives up on takes its divergence git down with it.
   */
  async compute(
    hasUpstream: boolean,
    signal: AbortSignal = this.host.abortSignal
  ): Promise<BaseDivergenceResult | null> {
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
      ? await this.resolveRemotes(branch, baseBranch, hasUpstream, dirs, signal)
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

    const git = await this.createGit(signal);

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
      if (resolution?.remotesReadSucceeded && resolution.availableRemotes.length === 0) {
        result = await git.raw(["rev-list", "--count", "--left-right", `${localRef}...HEAD`]);
        resolvedRef = localRef;
        resolvedRemote = null;
      } else {
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
      }
      const trimmed = result.trim();
      const parts = trimmed.split("\t");
      const behindCount = parts[0] != null && parts[0] !== "" ? parseInt(parts[0], 10) : 0;
      const aheadCount = parts[1] != null && parts[1] !== "" ? parseInt(parts[1], 10) : 0;

      let matchesUpstream = false;
      let upstreamHeadSha: string | null = null;
      if (hasUpstream) {
        try {
          // One invocation resolves both revs — rev-parse prints one OID per
          // line, and either failing exits non-zero (caught below), matching
          // the previous two-call error semantics.
          const out = await git.raw(["rev-parse", "@{u}", resolvedRef]);
          const [upstreamCommit, baseCommit] = out.trim().split("\n");
          matchesUpstream = baseCommit !== undefined && upstreamCommit.trim() === baseCommit.trim();
          upstreamHeadSha = upstreamCommit.trim() || null;
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
        upstreamRef: hasUpstream ? (resolution?.upstreamRef ?? null) : null,
        upstreamHeadSha,
      };
      // A cancelled git reads as a failed probe above (no upstream match, no
      // head), which must not be cached as this key's answer.
      if (signal.aborted) {
        this.lastKey = null;
        return null;
      }
      this.lastKey = key;
      this.lastResult = divergence;
      return divergence;
    } catch {
      this.lastKey = null;
      return null;
    }
  }

  private async createGit(signal: AbortSignal): Promise<GitRunner> {
    const wsl = this.host.wslInvocation;
    return wsl
      ? await createWslHardenedGit(wsl, signal)
      : await createHardenedGit(this.host.path, signal);
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
   * Which remote ref the base branch should be compared against, and where
   * `@{u}` points. The base half is a repository question answered by the
   * shared resolver; only `@{u}` is this worktree's own, and it is cached here
   * behind its own stamp — on a steady poll loop neither spawns at all.
   */
  private async resolveRemotes(
    branch: string,
    baseBranch: string,
    hasUpstream: boolean,
    dirs: GitDirs,
    signal: AbortSignal
  ): Promise<RemoteResolution | null> {
    const selection = await this.sharedBase.resolve({
      gitDir: dirs.gitDir,
      commonDir: dirs.commonDir,
      branch,
      baseBranch,
      wslInvocation: this.host.wslInvocation,
      signal,
      statMtime: (path) => this.statPrecheck.statMtime(path),
      createGit: (gitSignal) => this.createGit(gitSignal),
    });
    // Cancelled reads come back as "no remotes" and "no upstream"; keep the
    // last real answer instead of adopting those.
    if (selection === null || signal.aborted) return this.resolution;

    const upstreamRef = await this.resolveUpstream(
      branch,
      hasUpstream,
      selection.availableRemotes.length > 1,
      dirs,
      signal
    );
    if (upstreamRef === undefined) return this.resolution;

    const previous = this.resolution;
    if (
      previous !== null &&
      previous.compareRef === selection.compareRef &&
      previous.remote === selection.remote &&
      previous.availableRemotes === selection.availableRemotes &&
      previous.remotesReadSucceeded === selection.remotesReadSucceeded &&
      previous.upstreamRef === upstreamRef
    ) {
      return previous;
    }
    this.resolution = {
      compareRef: selection.compareRef,
      remote: selection.remote,
      upstreamRef,
      availableRemotes: selection.availableRemotes,
      remotesReadSucceeded: selection.remotesReadSucceeded,
    };
    return this.resolution;
  }

  /**
   * Full ref `@{u}` resolves to, or null without one; `undefined` when the
   * read was cancelled. Re-read when the branch or its config moved, on the
   * retry clock while a configured upstream has no ref, and — with more than
   * one remote to track — at the same age ceiling as the base selection, since
   * an included config file can repoint it without touching anything stamped.
   */
  private async resolveUpstream(
    branch: string,
    hasUpstream: boolean,
    ambiguous: boolean,
    dirs: GitDirs,
    signal: AbortSignal
  ): Promise<string | null | undefined> {
    if (!hasUpstream) {
      // An upstream that comes back later must be read afresh, not served
      // from before it went away.
      this.upstreamRead = false;
      this.unresolvedUpstreamRetryMs = UNRESOLVED_UPSTREAM_RETRY_MIN_MS;
      return null;
    }

    const stamp = await this.buildUpstreamStamp(branch, dirs);
    const age = Date.now() - this.upstreamAt;
    const retryDue =
      (this.upstream === null && age >= this.unresolvedUpstreamRetryMs) ||
      (ambiguous && age >= RESOLUTION_MAX_AGE_MS);
    if (this.upstreamRead && !retryDue && (stamp === null || stamp === this.upstreamStamp)) {
      return this.upstream;
    }

    const git = await this.createGit(signal);
    const upstreamRef = await readSymbolicRef(git, "@{u}");
    if (signal.aborted) return undefined;

    this.unresolvedUpstreamRetryMs =
      upstreamRef === null && this.upstreamRead && this.upstream === null
        ? Math.min(this.unresolvedUpstreamRetryMs * 2, RESOLUTION_MAX_AGE_MS)
        : UNRESOLVED_UPSTREAM_RETRY_MIN_MS;
    this.upstreamRead = true;
    this.upstream = upstreamRef;
    this.upstreamAt = Date.now();
    this.upstreamStamp = stamp;
    return upstreamRef;
  }

  /**
   * Stat stamp gating the `@{u}` read: the effective config files — the
   * shared one and `gitDir/config.worktree`, which carries per-worktree
   * overrides when `extensions.worktreeConfig` is on — plus packed-refs, under
   * the branch whose upstream it is.
   */
  private async buildUpstreamStamp(branch: string, dirs: GitDirs): Promise<string | null> {
    const { gitDir, commonDir } = dirs;
    try {
      const stats = await Promise.all([
        this.statPrecheck.statMtime(pathJoin(commonDir, "config")),
        this.statPrecheck.statMtime(pathJoin(gitDir, "config.worktree")),
        this.statPrecheck.statMtime(pathJoin(commonDir, "packed-refs")),
      ]);
      return [branch, ...stats].join(" ");
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
      return [
        branch,
        baseBranch,
        hasUpstream,
        resolution?.compareRef ?? "",
        resolution?.upstreamRef ?? "",
        ...stats,
      ].join(" ");
    } catch {
      return null;
    }
  }
}
