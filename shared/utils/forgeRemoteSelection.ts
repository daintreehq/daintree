export interface ForgeRemoteCandidate {
  name: string;
  fetchUrl: string;
}

export interface ResolveForgeRemoteInputs {
  /** The repo's remote table (`git remote -v`), in git's own listing order. */
  remotes: readonly ForgeRemoteCandidate[];
  /** Per-project `forgeRemote` setting — a remote *name*, not a URL. */
  forgeRemote: string | null | undefined;
  /**
   * "Could a registered forge provider parse this URL?" — the Daintree
   * equivalent of `gh`'s known-host eligibility test. Injected rather than
   * imported because the two call sites answer it from different tables:
   * main asks `listMatchingProviders`, the workspace-host asks its relayed
   * `forgeProviderMatchers`. Omitted (or always-false) degrades to plain
   * name-order preference, which is still better than blind `origin`.
   */
  isSupportedRemote?: (url: string) => boolean;
}

/**
 * Pick which git remote the forge integration should talk to. Pure function —
 * no I/O, no registry import, no main-process bindings — so the workspace-host
 * UtilityProcess can import it directly (same constraint as
 * `forgeProviderResolver`, issue #8316).
 *
 * Precedence (issue #11408):
 *
 *   1. The `forgeRemote` setting, matched by exact name. The whole point of
 *      the setting is that the user has already answered this question.
 *   2. Remotes a registered provider can actually parse, ranked by
 *      `NAME_PREFERENCE` then git's listing order.
 *   3. The same ranking over all remotes, when nothing is parseable (or no
 *      predicate was supplied) — preserves the pre-fix behavior of handing a
 *      URL back and letting the provider chain reject it.
 *
 * Returns `null` only when there are no remotes at all.
 *
 * A `forgeRemote` naming a remote that no longer exists falls through to
 * auto-detect rather than resolving to nothing: a renamed or removed remote
 * would otherwise silently disable every forge affordance, which is the exact
 * failure this issue exists to fix.
 */
export function resolveForgeRemote(inputs: ResolveForgeRemoteInputs): ForgeRemoteCandidate | null {
  const { remotes, forgeRemote, isSupportedRemote } = inputs;

  const usable = remotes.filter((r) => typeof r.fetchUrl === "string" && r.fetchUrl.length > 0);
  if (usable.length === 0) return null;

  if (typeof forgeRemote === "string" && forgeRemote.length > 0) {
    const named = usable.find((r) => r.name === forgeRemote);
    if (named) return named;
  }

  if (isSupportedRemote) {
    const supported = usable.filter((r) => {
      try {
        return isSupportedRemote(r.fetchUrl);
      } catch {
        // A throwing matcher must not take down remote selection.
        return false;
      }
    });
    if (supported.length > 0) return preferByName(supported);
  }

  return preferByName(usable);
}

/**
 * `upstream` before `origin` before everything else, mirroring `gh` and
 * Magit/Forge. Deliberately omits `gh`'s literal `github` tier: Daintree is
 * forge-neutral, so a Gitea remote is as likely to be named `gitea`, and
 * hostname matching (step 2 above) already does that job properly.
 */
const NAME_PREFERENCE = ["upstream", "origin"];

function preferByName(remotes: readonly ForgeRemoteCandidate[]): ForgeRemoteCandidate {
  for (const name of NAME_PREFERENCE) {
    const match = remotes.find((r) => r.name === name);
    if (match) return match;
  }
  // Non-null: every caller has already checked for a non-empty list.
  return remotes[0]!;
}
