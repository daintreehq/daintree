import { readFile } from "fs/promises";
import { join as pathJoin } from "path";
import { resolveBaseCompareRef } from "../../shared/utils/baseRemoteSelection.js";
import {
  gatherBaseCompareRefInputsWithRemoteStatus,
  type BaseCompareRefGit,
} from "../utils/baseCompareRef.js";
import type { WslGitInvocation } from "../utils/hardenedGit.js";
import { timeoutSignal } from "../utils/withTimeout.js";
import { STAT_ABSENT_SENTINEL } from "./StatPrecheck.js";

/**
 * Ceiling on how long a cached base resolution may be reused while its stat
 * stamp looks unchanged. The stamp covers the mutations that matter (config
 * writes, packed-refs, the candidate refs themselves), but a stat set is a
 * fixed set — anything outside it changes invisibly, exactly the failure class
 * #10956 fixed for the status pre-check. `git remote add upstream` followed by
 * a fetch that only touches a nested `refs/remotes/upstream/release/` directory
 * is the concrete case. The ceiling bounds every such miss to one interval
 * instead of forever, for the cost of a handful of local git spawns per
 * repository per interval.
 */
export const RESOLUTION_MAX_AGE_MS = 5 * 60_000;
const CONFIG_READ_TIMEOUT_MS = 5_000;
// Entries hold a few short strings each; the cap only stops a long session of
// branch switches in privately-scoped repos from growing the map forever.
export const MAX_ENTRIES = 256;

/** The repository-wide half of base-ref resolution. */
export interface SharedBaseSelection {
  /** Short ref to diff against (`upstream/main`), or null to use the fallback chain. */
  readonly compareRef: string | null;
  /** Remote `compareRef` lives on. */
  readonly remote: string | null;
  /** `git remote` output, so callers' stat stamps can cover each candidate ref. */
  readonly availableRemotes: readonly string[];
  /** Whether an empty `availableRemotes` came from a successful `git remote`. */
  readonly remotesReadSucceeded: boolean;
}

export interface SharedBaseRequest {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly wslInvocation: WslGitInvocation | undefined;
  /** Stops this caller's wait, and the git it runs when it leads the probe. */
  readonly signal: AbortSignal;
  statMtime(path: string): Promise<number>;
  createGit(signal: AbortSignal): Promise<BaseCompareRefGit>;
}

/** What a probe settled to. `cancelled` results are never cached. */
interface ProbeOutcome {
  selection: SharedBaseSelection | null;
  cancelled: boolean;
}

interface Entry {
  selection: SharedBaseSelection | null;
  stamp: string | null;
  resolvedAt: number;
  probe: Promise<ProbeOutcome> | null;
  /** Callers inside `resolve` holding this entry; eviction skips it while any are. */
  holders: number;
}

const ABANDONED = Symbol("abandoned");

/**
 * Which remote ref a base branch should be compared against is a question about
 * the repository, not the worktree: `git remote`, `<base>@{upstream}` and the
 * `for-each-ref` over candidate refs all read the shared config and refs. Every
 * linked worktree's `BaseDivergence` used to ask it separately, so a cold load
 * or a fetch that moved the base ref cost `N ×` the same two or three spawns.
 * One instance per workspace service answers it once per repository, base
 * branch and git runtime, and concurrent askers join the probe in flight.
 *
 * Worktrees only share an answer when their effective config is the shared
 * one. A worktree with its own `config.worktree` (`extensions.worktreeConfig`
 * can override `branch.<base>.*` and `remote.*` there) resolves privately, and
 * so does every worktree of a repository whose own config includes another
 * file: `onbranch:` and `gitdir:` conditions can differ between siblings, and
 * an unconditional include can carry conditions of its own, which only
 * following git's include rules would reveal. Includes in user-level config
 * are not looked for: a `gitdir:` pattern matches every sibling alike (their
 * private git dirs all live under the shared common dir), and steering a base
 * branch's remote by the checked-out branch from user config is not a setup
 * worth a spawn per poll.
 */
export class SharedBaseRefResolver {
  private entries = new Map<string, Entry>();
  private readonly includeScans = new Map<string, { mtime: number; includes: boolean }>();

  /**
   * The cached selection for this request's repository, re-probed when its
   * stamp moved or it aged out. Returns the last good selection (or null when
   * there is none) if the caller's signal aborts, and never caches what a
   * cancelled probe read.
   */
  async resolve(request: SharedBaseRequest): Promise<SharedBaseSelection | null> {
    const scope = await this.scopeFor(request);
    const key = [
      request.wslInvocation ? `wsl:${request.wslInvocation.distro}` : "native",
      request.commonDir,
      request.baseBranch,
      scope,
    ].join("\0");

    for (;;) {
      if (request.signal.aborted) return this.entries.get(key)?.selection ?? null;
      const entry = this.entryFor(key);
      entry.holders++;
      try {
        if (entry.probe) {
          const outcome = await waitUnlessAborted(entry.probe, request.signal);
          if (outcome === ABANDONED) return entry.selection;
          // The leader was cancelled. Live joiners go round again, and the
          // first to get there leads the replacement probe the rest join.
          if (outcome.cancelled && !request.signal.aborted) continue;
          return outcome.selection;
        }

        const stamp = await this.buildStamp(request, entry.selection?.availableRemotes ?? []);
        // Someone else started a probe, or the cache was cleared, during the stats.
        if (entry.probe || this.entries.get(key) !== entry) continue;
        if (entry.selection !== null && this.isFresh(entry, stamp)) return entry.selection;

        const probe = this.probe(key, entry, request);
        entry.probe = probe;
        const settle = () => {
          if (entry.probe === probe) entry.probe = null;
        };
        probe.then(settle, settle);
        const outcome = await probe;
        return outcome.selection;
      } finally {
        entry.holders--;
      }
    }
  }

  /** Forget every repository. A probe still in flight publishes nothing. */
  clear(): void {
    this.entries = new Map();
    this.includeScans.clear();
  }

  private entryFor(key: string): Entry {
    const existing = this.entries.get(key);
    if (existing) return existing;
    // A burst of held entries can carry the map past the cap; the next insert
    // trims every idle overflow, oldest first, so it settles back under it.
    for (const [oldKey, old] of this.entries) {
      if (this.entries.size < MAX_ENTRIES) break;
      if (old.probe || old.holders > 0) continue;
      this.entries.delete(oldKey);
    }
    const entry: Entry = { selection: null, stamp: null, resolvedAt: 0, probe: null, holders: 0 };
    this.entries.set(key, entry);
    return entry;
  }

  private isFresh(entry: Entry, stamp: string | null): boolean {
    // The age ceiling only earns its spawns where the answer is genuinely
    // ambiguous. With at most one remote there is nothing to choose between,
    // and anything that could introduce a second one writes the config, which
    // the stamp already covers — so the overwhelmingly common repo re-resolves
    // on real events only, never on a timer.
    const ambiguous = (entry.selection?.availableRemotes.length ?? 0) > 1;
    if (ambiguous && Date.now() - entry.resolvedAt >= RESOLUTION_MAX_AGE_MS) return false;
    // A null stamp means a stat failed unexpectedly. Re-probing on every such
    // poll would turn a flaky filesystem into a spawn storm, so the cached
    // answer is held until it ages out on its own.
    return stamp === null || stamp === entry.stamp;
  }

  private async probe(
    key: string,
    entry: Entry,
    request: SharedBaseRequest
  ): Promise<ProbeOutcome> {
    const { signal } = request;
    const git = await request.createGit(signal);
    // Shared with the rebase/merge handlers (#12092) so the ref an operation
    // acts on is the ref the behind count was measured against.
    const { inputs, remotesReadSucceeded } = await gatherBaseCompareRefInputsWithRemoteStatus(
      git,
      request.baseBranch
    );
    // Cancelled reads come back as "no remotes"; keep the last real answer
    // instead of caching those.
    if (signal.aborted) return { selection: entry.selection, cancelled: true };

    const { compareRef, remote } = resolveBaseCompareRef(inputs);
    const selection: SharedBaseSelection = {
      compareRef,
      remote,
      availableRemotes: inputs.availableRemotes,
      remotesReadSucceeded,
    };
    // Re-derive the stamp: the first probe discovers the remote names the
    // stamp's candidate-ref stats are built from, so the stamp computed before
    // probing covered fewer paths than the one that must match next time.
    const stamp = await this.buildStamp(request, selection.availableRemotes);
    if (this.entries.get(key) === entry) {
      entry.selection = selection;
      entry.stamp = stamp;
      entry.resolvedAt = Date.now();
    }
    return { selection, cancelled: false };
  }

  /**
   * `""` when this worktree reads the repository's shared config, otherwise a
   * scope private to it. A failed stat or read errs private: a lost share costs
   * a few spawns, a wrong one compares against the wrong base.
   */
  private async scopeFor(request: SharedBaseRequest): Promise<string> {
    const privateScope = `${request.gitDir}\0${request.branch}`;
    try {
      const worktreeConfig = await request.statMtime(pathJoin(request.gitDir, "config.worktree"));
      if (worktreeConfig !== STAT_ABSENT_SENTINEL) return privateScope;
      return (await this.hasIncludes(request)) ? privateScope : "";
    } catch {
      return privateScope;
    }
  }

  private async hasIncludes(request: SharedBaseRequest): Promise<boolean> {
    const configPath = pathJoin(request.commonDir, "config");
    const mtime = await request.statMtime(configPath);
    if (mtime === STAT_ABSENT_SENTINEL) return false;
    const cached = this.includeScans.get(request.commonDir);
    if (cached?.mtime === mtime) return cached.includes;

    const { signal, dispose } = timeoutSignal(CONFIG_READ_TIMEOUT_MS);
    let includes: boolean;
    try {
      const text = await readFile(configPath, { encoding: "utf-8", signal });
      // Section names are case-insensitive: `[include]`, `[includeIf "…"]`.
      includes = /^\s*\[\s*include(?:if)?\b/im.test(text);
    } catch {
      includes = true;
    } finally {
      dispose();
    }
    this.includeScans.set(request.commonDir, { mtime, includes });
    return includes;
  }

  /**
   * Stat stamp gating the probe: the effective config files, packed-refs, and
   * each known remote's candidate ref, so a newly fetched base ref re-opens the
   * question. `config.worktree` is always absent for a shared scope, so
   * stamping it costs siblings nothing and covers a private scope's overrides.
   */
  private async buildStamp(
    request: SharedBaseRequest,
    availableRemotes: readonly string[]
  ): Promise<string | null> {
    const { gitDir, commonDir, baseBranch } = request;
    try {
      const candidatePaths = availableRemotes.map((remote) =>
        pathJoin(commonDir, "refs", "remotes", ...remote.split("/"), ...baseBranch.split("/"))
      );
      const stats = await Promise.all([
        request.statMtime(pathJoin(commonDir, "config")),
        request.statMtime(pathJoin(gitDir, "config.worktree")),
        request.statMtime(pathJoin(commonDir, "packed-refs")),
        ...candidatePaths.map((path) => request.statMtime(path)),
      ]);
      return stats.join(" ");
    } catch {
      return null;
    }
  }
}

/** Settles with the promise, or with {@link ABANDONED} as soon as `signal` aborts. */
function waitUnlessAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T | typeof ABANDONED> {
  if (signal.aborted) return Promise.resolve(ABANDONED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABANDONED);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
