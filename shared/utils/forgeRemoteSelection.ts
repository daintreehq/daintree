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
   * imported because the call sites answer it from different tables: main asks
   * `listMatchingProviders`, the workspace-host asks its relayed
   * `forgeProviderMatchers`, the Settings panel asks the provider list it has
   * already loaded. Omitted (or always-false) degrades to plain name
   * preference, which is still better than blind `origin`.
   */
  isSupportedRemote?: (url: string) => boolean;
}

export interface ForgeRemoteSelection {
  /** The remote to route through, or `null` when none can be selected. */
  remote: ForgeRemoteCandidate | null;
  /**
   * Set to the configured name when `forgeRemote` named a remote that is not
   * in the table. Callers MUST NOT substitute another remote in this case —
   * see the fail-closed note on {@link resolveForgeRemote}.
   */
  missingConfiguredRemote: string | null;
}

/**
 * Pick which git remote the forge integration should talk to. Pure function —
 * no I/O, no registry import, no main-process bindings — so the workspace-host
 * UtilityProcess and the renderer can both import it (same constraint as
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
 * Fails CLOSED when `forgeRemote` names a remote that is not in the table:
 * returns `{ remote: null, missingConfiguredRemote: name }` rather than
 * quietly auto-detecting. `resolveForCwd` backs mutations (assign, close,
 * merge), so substituting a different repository for the one the user named
 * would let a renamed remote silently redirect a write to a fork — exactly the
 * "no silent fallback defaults" rule in CLAUDE.md. A dark toolbar is a visible
 * prompt to fix the setting; a write to the wrong repo is not recoverable.
 */
export function resolveForgeRemote(inputs: ResolveForgeRemoteInputs): ForgeRemoteSelection {
  const { remotes, forgeRemote, isSupportedRemote } = inputs;

  const usable = remotes.filter((r) => typeof r.fetchUrl === "string" && r.fetchUrl.length > 0);

  if (typeof forgeRemote === "string" && forgeRemote.length > 0) {
    const named = usable.find((r) => r.name === forgeRemote);
    return named
      ? { remote: named, missingConfiguredRemote: null }
      : { remote: null, missingConfiguredRemote: forgeRemote };
  }

  if (usable.length === 0) return { remote: null, missingConfiguredRemote: null };

  if (isSupportedRemote) {
    const supported = usable.filter((r) => {
      try {
        return isSupportedRemote(r.fetchUrl);
      } catch {
        // A throwing matcher must not take down remote selection.
        return false;
      }
    });
    if (supported.length > 0) {
      return { remote: preferByName(supported), missingConfiguredRemote: null };
    }
  }

  return { remote: preferByName(usable), missingConfiguredRemote: null };
}

/**
 * `origin` before `upstream` before everything else.
 *
 * Deliberately NOT `gh`'s `upstream → github → origin`: `PullRequestService`
 * and the built-in GitHub context both auto-detect origin-first, and a resolver
 * that preferred `upstream` would make the toolbar read the canonical repo
 * while the worktree PR badges read the fork. Preferring origin keeps every
 * consumer on the same repository whenever origin is usable, so this fix
 * changes behavior only in the case the issue actually reports — origin absent
 * or unparseable. `gh`'s literal `github` tier is omitted for a second reason:
 * Daintree is forge-neutral, so a Gitea remote is as likely to be named
 * `gitea`, and provider matching above already does that job properly.
 */
const NAME_PREFERENCE = ["origin", "upstream"];

function preferByName(remotes: readonly ForgeRemoteCandidate[]): ForgeRemoteCandidate {
  for (const name of NAME_PREFERENCE) {
    const match = remotes.find((r) => r.name === name);
    if (match) return match;
  }
  // Non-null: every caller has already checked for a non-empty list.
  return remotes[0]!;
}
