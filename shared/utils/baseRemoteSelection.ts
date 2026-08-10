const REMOTE_REF_PREFIX = "refs/remotes/";

/**
 * git's "local repository" pseudo-remote. A branch configured with
 * `branch.<name>.remote = .` tracks another *local* branch, so there is no
 * remote-tracking ref to diff against and nothing to fetch.
 */
const LOCAL_PSEUDO_REMOTE = ".";

export interface ResolveBaseCompareRefInputs {
  /** The branch the worktree measures itself against (`main`, `release/2.0`). */
  baseBranch: string;
  /**
   * `<baseBranch>@{upstream}` resolved to a full ref
   * (`refs/remotes/upstream/main`), or `null` when the base branch has no
   * local counterpart or no tracking config.
   *
   * Deliberately the *resolved ref* rather than `branch.<base>.remote`: a
   * branch may track a differently-named remote branch
   * (`branch.develop.merge = refs/heads/main`), and appending `/<baseBranch>`
   * to a bare remote name would build a ref that doesn't exist.
   */
  trackedRef: string | null;
  /** Remote names that actually carry `refs/remotes/<remote>/<baseBranch>`. */
  remotesWithBaseRef: readonly string[];
  /** `git remote` output — the remotes that exist at all. */
  availableRemotes: readonly string[];
}

export interface BaseCompareRefSelection {
  /**
   * Short ref to diff against (`upstream/main`), or `null` when nothing
   * resolved — callers keep their existing `origin/<base>` → local-`<base>`
   * fallback chain, so single-remote and no-remote repos are unaffected.
   */
  compareRef: string | null;
  /**
   * Remote `compareRef` lives on. This is the remote background fetch has to
   * refresh; a resolved ref that is never fetched is just a different way to
   * be stale.
   */
  remote: string | null;
}

/**
 * Pick the remote-tracking ref the base-branch divergence should compare
 * against. Pure function — no I/O, no registry import, no main-process
 * bindings — so the workspace-host UtilityProcess and the renderer can both
 * import it (same constraint as `forgeRemoteSelection`, issue #8316).
 *
 * Precedence (issue #11747):
 *
 *   1. The base branch's own tracking ref, when it has one. Explicit git
 *      config beats any heuristic: the user already answered the question.
 *   2. Otherwise the remotes that actually carry the base branch, ranked by
 *      {@link NAME_PREFERENCE}.
 *   3. Otherwise `null` — the caller keeps today's behavior.
 *
 * Fails SOFT throughout, which is the opposite of `resolveForgeRemote`'s
 * fail-closed contract, and deliberately so: this feeds a *displayed count*,
 * while `resolveForgeRemote` backs mutations where substituting a repository
 * could redirect a write to a fork. The worst case here is the pre-fix
 * behavior, so there is no configuration in which this resolver makes a repo
 * worse off than it is today.
 */
export function resolveBaseCompareRef(
  inputs: ResolveBaseCompareRefInputs
): BaseCompareRefSelection {
  const { baseBranch, trackedRef, remotesWithBaseRef, availableRemotes } = inputs;

  const tracked = parseRemoteRef(trackedRef, availableRemotes);
  if (tracked) return tracked;

  const candidates = remotesWithBaseRef.filter(
    (remote) => remote !== LOCAL_PSEUDO_REMOTE && availableRemotes.includes(remote)
  );
  if (candidates.length === 0) return { compareRef: null, remote: null };

  const remote = preferByName(candidates);
  return { compareRef: `${remote}/${baseBranch}`, remote };
}

export interface FetchRemotePlanInputs {
  /** Remote the base divergence compares against, or `null` if unresolved. */
  baseRemote: string | null;
  /** `git remote` output. Empty before the first resolution has run. */
  availableRemotes: readonly string[];
}

export interface FetchRemotePlan {
  /** Remotes background fetch should refresh, primary first, deduped. */
  remotes: string[];
  /** The remote whose freshness the displayed counts depend on. */
  primaryRemote: string;
}

/**
 * Decide which remotes a worktree's background fetch has to refresh.
 *
 * Two remotes are read on a fork layout and both must be fresh: the base
 * remote, which the `↓N behind` count is measured against, and `origin`, which
 * normally carries the branch's own `@{u}` and therefore the top-line
 * ahead/behind counts. On the single-remote repos that are the overwhelming
 * majority these collapse to one entry, so the common case still issues
 * exactly one `git fetch` — the same one it issued before #11747.
 *
 * `origin` is included only when the repo actually has it. A repo whose sole
 * remote is named something else must not acquire a guaranteed-failing
 * `git fetch origin` that would then occupy a real backoff slot.
 */
export function planFetchRemotes(inputs: FetchRemotePlanInputs): FetchRemotePlan {
  const { baseRemote, availableRemotes } = inputs;
  const hasOrigin = availableRemotes.includes(DEFAULT_REMOTE);

  // Before the first divergence resolution lands, `availableRemotes` is empty
  // and this returns plain `origin` — byte-identical to the pre-#11747
  // behavior, and self-correcting on the next poll.
  const primaryRemote =
    baseRemote ??
    (hasOrigin || availableRemotes.length === 0 ? DEFAULT_REMOTE : availableRemotes[0]!);

  const remotes = [primaryRemote];
  if (hasOrigin && !remotes.includes(DEFAULT_REMOTE)) remotes.push(DEFAULT_REMOTE);
  return { remotes, primaryRemote };
}

/** git's conventional default remote, and the pre-#11747 hardcoded one. */
const DEFAULT_REMOTE = "origin";

/**
 * Split `refs/remotes/<remote>/<branch>` into its remote and short-ref parts.
 *
 * Remote names may themselves contain `/`, so the boundary can't be found by
 * position — it's resolved by testing the known remote names longest-first,
 * which makes `foo/bar` win over a hypothetical `foo` for
 * `refs/remotes/foo/bar/main`.
 */
function parseRemoteRef(
  fullRef: string | null,
  availableRemotes: readonly string[]
): BaseCompareRefSelection | null {
  if (!fullRef || !fullRef.startsWith(REMOTE_REF_PREFIX)) return null;
  const shortRef = fullRef.slice(REMOTE_REF_PREFIX.length);
  if (!shortRef) return null;

  const byLongestName = [...availableRemotes].sort((a, b) => b.length - a.length);
  for (const remote of byLongestName) {
    if (remote === LOCAL_PSEUDO_REMOTE) continue;
    if (shortRef.startsWith(`${remote}/`) && shortRef.length > remote.length + 1) {
      return { compareRef: shortRef, remote };
    }
  }
  return null;
}

/**
 * `upstream` before `origin` before everything else.
 *
 * Deliberately the INVERSE of `forgeRemoteSelection`'s origin-first ladder,
 * because the two resolvers answer different questions. That one picks the
 * repository the forge integration talks to, where preferring origin keeps
 * the toolbar and the PR badges on one repo. This one picks the ref that
 * represents "the canonical base I might be behind" — and on the fork layout
 * this issue is about (`origin` = your fork, `upstream` = canonical), origin
 * is precisely the ref that reads `↓0` while the branch sits hundreds of
 * commits behind. `upstream` has exactly one conventional meaning in git and
 * it is this one.
 *
 * Only reached when the base branch has no tracking config AND more than one
 * remote carries it, so single-remote repos never observe the difference.
 */
const NAME_PREFERENCE = ["upstream", "origin"];

function preferByName(remotes: readonly string[]): string {
  for (const name of NAME_PREFERENCE) {
    if (remotes.includes(name)) return name;
  }
  // Non-null: the caller has already checked for a non-empty list.
  return remotes[0]!;
}
