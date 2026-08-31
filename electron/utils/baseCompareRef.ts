import {
  resolveBaseCompareRef,
  type ResolveBaseCompareRefInputs,
} from "../../shared/utils/baseRemoteSelection.js";

/**
 * The I/O half of base-branch ref resolution (#12092).
 *
 * `resolveBaseCompareRef` is pure and lives in `shared/` so the workspace-host
 * UtilityProcess and the renderer can both import it. Its three inputs are not:
 * each is a local `git raw` read. Those reads used to be private methods on
 * `BaseDivergence`, which was fine while the displayed behind-count was their
 * only consumer. It stopped being fine the moment a *write* had to act on the
 * same ref: a rebase measured against one resolution and executed against
 * another is a silently wrong target, and duplicating three readers is exactly
 * how the two drift.
 *
 * Everything here fails SOFT, matching `resolveBaseCompareRef`'s own contract —
 * a git failure yields "nothing resolved", and the caller keeps its fallback
 * chain. {@link resolveExistingBaseCompareTarget} is the one exception in
 * spirit: it returns `null` rather than guessing, and every write refuses on
 * `null` rather than defaulting to `origin`.
 */

const REMOTE_REF_PREFIX = "refs/remotes/";
const LOCAL_REF_PREFIX = "refs/heads/";

/** git's conventional default remote — the pre-#11747 hardcoded one. */
const DEFAULT_REMOTE = "origin";

/** The slice of a simple-git instance these readers use. */
export interface BaseCompareRefGit {
  raw(args: string[]): Promise<string>;
}

/** `git remote` — names only, no URLs, no network. */
export async function readRemotes(git: BaseCompareRefGit): Promise<string[]> {
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
 * Resolve a revision to its full symbolic ref. Returns `null` when the revision
 * has no upstream (git exits non-zero), which is the normal case for an
 * unpushed branch.
 */
export async function readSymbolicRef(git: BaseCompareRefGit, rev: string): Promise<string | null> {
  try {
    const out = await git.raw(["rev-parse", "--symbolic-full-name", rev]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Which remotes carry `<baseBranch>`. Uses `for-each-ref` rather than a readdir
 * so packed refs are found too.
 *
 * One literal pattern per known remote rather than a single `refs/remotes/*`
 * glob: git's ref-filter wildcard does not cross `/`, so a remote whose own
 * name contains a slash (`team/fork`) would never appear in the glob's output,
 * and the exact cross-reference below cannot recover a ref that was never
 * listed.
 */
export async function readRemotesCarrying(
  git: BaseCompareRefGit,
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
      // Remote names may contain `/`, so match against the known names rather
      // than splitting on the first separator.
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
 * Gather everything {@link resolveBaseCompareRef} needs, in the order
 * `BaseDivergence` has always read it.
 *
 * `remotesWithBaseRef` is skipped entirely when the base branch has a tracking
 * ref, because explicit git config wins outright and the `for-each-ref` spawn
 * would be discarded. That short-circuit is behaviour, not an optimisation:
 * this runs on a poll loop per worktree.
 */
export async function gatherBaseCompareRefInputs(
  git: BaseCompareRefGit,
  baseBranch: string
): Promise<ResolveBaseCompareRefInputs> {
  const availableRemotes = await readRemotes(git);
  const trackedRef = await readSymbolicRef(git, `${baseBranch}@{upstream}`);
  const remotesWithBaseRef = trackedRef
    ? []
    : await readRemotesCarrying(git, baseBranch, availableRemotes);
  return { baseBranch, trackedRef, remotesWithBaseRef, availableRemotes };
}

/** A base ref that was confirmed to exist, named both ways. */
export interface ExistingBaseCompareTarget {
  /** Short, human-facing form — `upstream/develop`, or a bare `develop`. */
  compareRef: string;
  /**
   * Fully-qualified form, and the ONLY spelling that reaches argv.
   *
   * `refs/remotes/…` and `refs/heads/…` prefixes make a leading `-`
   * impossible, so a branch named like a flag cannot become one.
   */
  fullRef: string;
  /** Remote the ref lives on, or `null` on the local-branch fallback. */
  remote: string | null;
}

/**
 * Does `fullRef` name a commit that exists right now?
 *
 * `rev-parse --verify --quiet` exits non-zero without writing to stderr when it
 * does not, which simple-git surfaces as a rejection — so absence arrives as a
 * throw, not as an empty string. `^{commit}` peels an annotated tag rather than
 * reporting the tag object as a usable rebase target.
 */
async function refExists(git: BaseCompareRefGit, fullRef: string): Promise<boolean> {
  try {
    const out = await git.raw(["rev-parse", "--verify", "--quiet", `${fullRef}^{commit}`]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The base ref a rebase or merge should act on, or `null` when none exists.
 *
 * The ladder mirrors `BaseDivergence.compute()` exactly — selected ref, then
 * `origin/<base>`, then the local branch — so an operation always targets the
 * same commit the `↓N behind` badge measured against. Diverging here would let
 * the card promise one integration and the menu perform another.
 *
 * Each rung is verified to exist before it is offered. `BaseDivergence` can get
 * away with trying a `rev-list` and catching the failure because a miss costs a
 * displayed number; a write cannot, because a miss costs a git invocation
 * against a ref that turns out to be a pathspec.
 *
 * Fails CLOSED at the end. Returning `origin/<base>` unverified would be the
 * reassuring answer and the wrong one — the same fail-closed rule every
 * remote-mutating path already follows (#11746).
 */
export async function resolveExistingBaseCompareTarget(
  git: BaseCompareRefGit,
  baseBranch: string
): Promise<ExistingBaseCompareTarget | null> {
  const inputs = await gatherBaseCompareRefInputs(git, baseBranch);
  const { compareRef, remote } = resolveBaseCompareRef(inputs);

  const candidates: ExistingBaseCompareTarget[] = [];
  if (compareRef && remote) {
    candidates.push({ compareRef, remote, fullRef: `${REMOTE_REF_PREFIX}${compareRef}` });
  }
  // `origin/<base>` is tried even when the resolver declined to name it: the
  // resolver only ranks remotes it could prove carry the branch, and a repo
  // whose `for-each-ref` read failed transiently still has an origin.
  if (compareRef !== `${DEFAULT_REMOTE}/${baseBranch}`) {
    candidates.push({
      compareRef: `${DEFAULT_REMOTE}/${baseBranch}`,
      remote: DEFAULT_REMOTE,
      fullRef: `${REMOTE_REF_PREFIX}${DEFAULT_REMOTE}/${baseBranch}`,
    });
  }
  // A repo with no remote at all falls back to the local base branch. Rebasing
  // ONTO a local `develop` from a linked worktree is fine — git only refuses to
  // *write* a branch checked out somewhere else.
  candidates.push({
    compareRef: baseBranch,
    remote: null,
    fullRef: `${LOCAL_REF_PREFIX}${baseBranch}`,
  });

  for (const candidate of candidates) {
    if (await refExists(git, candidate.fullRef)) return candidate;
  }
  return null;
}
