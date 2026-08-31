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
 * **The ladder is `BaseDivergence.compute()`'s, rung for rung**, and that is the
 * whole contract of this function rather than an implementation note. The card
 * says `↓N behind`; the menu row acts. If the two resolve differently the card
 * promises one integration and the menu performs another, with nothing on
 * screen to give it away.
 *
 * So there are exactly TWO rungs, matching `compute()`:
 *
 *   1. `resolution.compareRef`, defaulting to `origin/<base>` when the resolver
 *      declined to name one — the same `?? origin/<base>` that function uses.
 *   2. the local `<base>` branch.
 *
 * An `origin/<base>` rung between them is deliberately NOT here, tempting as it
 * is. It would fire in exactly one case — the base tracks, say,
 * `upstream/develop`, that ref has been pruned, and `origin/develop` still
 * exists — and in that case `compute()` falls through to the LOCAL branch. A
 * third rung would make the menu rebase onto `origin/develop` while the badge
 * counted against local `develop`.
 *
 * Two deliberate differences from `compute()`, neither of which moves the
 * target commit:
 *
 * - Refs are fully qualified. `compute()` passes the short `origin/<base>`,
 *   which git resolves through `refs/heads/` BEFORE `refs/remotes/` — so a
 *   local branch literally named `origin/develop` shadows the remote-tracking
 *   ref there. Writing `refs/remotes/…` is both unambiguous and the reason a
 *   branch named like a flag cannot reach argv as one.
 * - Existence is checked with `rev-parse --verify`, where `compute()` just
 *   tries its `rev-list` and catches the failure. It can afford that because a
 *   miss costs a displayed number; a write cannot, because a miss costs a git
 *   invocation against a ref that turns out to be a pathspec.
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
  const resolved = resolveBaseCompareRef(inputs);

  // `?? origin/<base>` — `compute()`'s own default for an unresolved ref, which
  // is also what this repo did before the resolver existed (#11747).
  const remote = resolved.compareRef ? resolved.remote : DEFAULT_REMOTE;
  const compareRef = resolved.compareRef ?? `${DEFAULT_REMOTE}/${baseBranch}`;

  const candidates: ExistingBaseCompareTarget[] = [
    // `remote` is non-null whenever `compareRef` is — `resolveBaseCompareRef`
    // sets them together — so this is a total guard, not a fallback.
    ...(remote ? [{ compareRef, remote, fullRef: `${REMOTE_REF_PREFIX}${compareRef}` }] : []),
    // A repo with no remote at all falls back to the local base branch. Rebasing
    // ONTO a local `develop` from a linked worktree is fine — git only refuses
    // to *write* a branch checked out somewhere else.
    { compareRef: baseBranch, remote: null, fullRef: `${LOCAL_REF_PREFIX}${baseBranch}` },
  ];

  for (const candidate of candidates) {
    if (await refExists(git, candidate.fullRef)) return candidate;
  }
  return null;
}
