import type {
  ForgeIssueProviderSelection,
  ForgeProviderEntry,
  ForgeProviderResolutionVia,
  RegisteredForgeProvider,
  ResolvedForgeProvider,
} from "../../shared/types/forge.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";
import { forgeProviderServesRole } from "../../shared/utils/forgeProviderRoles.js";
import { getRegisteredForgeProviders, listMatchingProviders } from "./forgeProviderRegistry.js";

interface CodeSelection {
  entry: ForgeProviderEntry | null;
  resolvedVia: ForgeProviderResolutionVia | null;
}

const NO_CODE: CodeSelection = { entry: null, resolvedVia: null };
const NO_ISSUES: ForgeIssueProviderSelection = { entry: null, resolvedVia: null };

export interface ResolveForgeProviderInputs {
  /** Project's `origin` remote URL. Used for hostname matching when no override
   *  resolves. `null`/`undefined` skips hostname matching (no candidates). */
  remoteUrl: string | null | undefined;
  /** Per-project override (`forgeProviderOverride`). Canonical id
   *  (`"daintree.github.github"`, #8451). The storage read boundary normalizes
   *  the known built-in aliases — third-party bare ids fall through unchanged
   *  and `findById` still accepts them for backward compatibility. Set wins
   *  over default. */
  forgeProviderOverride: string | null | undefined;
  /** Global default (`forgeDefaultProviderId`). Canonical id, same caveat. */
  globalDefaultProviderId: string | null | undefined;
  /**
   * Per-project issues binding (`issueProviderOverride`, #13700). Unset means
   * the code provider serves issues too. Canonical id, same caveat.
   */
  issueProviderOverride?: string | null;
}

/**
 * Pick the active forge provider for each role from the candidates the
 * registry exposes. Pure function — no I/O, no main-process bindings — so safe to call
 * from the workspace-host UtilityProcess (issue #8316: importing `projectStore`
 * here pulled `BrowserWindow`/`app` into the host bundle via the persistence
 * chain).
 *
 * Code-role precedence (issue #8112), over providers serving code only:
 *
 *   1. Per-project override (`forgeProviderOverride`, #8111) — if set and the
 *      named provider is still registered.
 *   2. Global default (`forgeDefaultProviderId`, #8110) — if set and the named
 *      provider is one of the candidates for the project's remote.
 *   3. First hostname match from `listMatchingProviders(remoteUrl)`.
 *
 * The issues role (#13700) is the project's `issueProviderOverride` when set,
 * otherwise the code provider — see {@link resolveIssuesProvider}.
 *
 * Returns `{ entry: null, resolvedVia: null }` for a role no rule resolves. Consumers
 * treat `entry === null` the same as "no provider registered" (quiet linkage
 * absence, no toast, no log spam).
 *
 * `resolvedVia` reports which precedence tier picked the entry so the
 * Preferences UI can render an explanatory tooltip without re-implementing
 * the chain. Issue #8064.
 */
export function resolveForgeProvider(inputs: ResolveForgeProviderInputs): ResolvedForgeProvider {
  const code = resolveCodeProvider(inputs);
  return { ...code, issues: resolveIssuesProvider(inputs.issueProviderOverride, code) };
}

function resolveCodeProvider(inputs: ResolveForgeProviderInputs): CodeSelection {
  const { remoteUrl, forgeProviderOverride, globalDefaultProviderId } = inputs;

  // 1. Per-project override — searches the full registry, not just remote
  //    candidates. A user who names a provider overrides hostname matching
  //    entirely. Override-set-but-unregistered returns null (no fallthrough),
  //    and so does an override naming an issues-only provider: it has no PR,
  //    CI or repository surface to serve.
  if (typeof forgeProviderOverride === "string" && forgeProviderOverride.length > 0) {
    const match = findById(codeProviders(getRegisteredForgeProviders()), forgeProviderOverride);
    return match ? { entry: match, resolvedVia: "override" } : NO_CODE;
  }

  if (typeof remoteUrl !== "string" || remoteUrl.length === 0) return NO_CODE;
  const candidates = codeProviders(listMatchingProviders(remoteUrl));

  // 2. Global default — must be one of the remote's candidates. A default
  //    that does not match this project's remote returns null (no fallthrough).
  if (typeof globalDefaultProviderId === "string" && globalDefaultProviderId.length > 0) {
    const match = findById(candidates, globalDefaultProviderId);
    return match ? { entry: match, resolvedVia: "default" } : NO_CODE;
  }

  // 3. First hostname match (or null if there are no candidates).
  const first = candidates[0];
  return first ? { entry: first, resolvedVia: "hostname" } : NO_CODE;
}

/**
 * Resolved independently of the remote: an issues-only provider has none, so a
 * project with no remote (or no code provider) can still have its issues.
 *
 * A set override that names nothing usable — unregistered, plugin disabled, or
 * a code-only provider — yields no issues provider rather than falling back to
 * the code forge. The user asked for issues from somewhere specific, and
 * quietly serving the code forge's issues instead would put the wrong tracker's
 * numbers in the picker and on new worktrees.
 */
function resolveIssuesProvider(
  issueProviderOverride: string | null | undefined,
  code: CodeSelection
): ForgeIssueProviderSelection {
  if (typeof issueProviderOverride === "string" && issueProviderOverride.length > 0) {
    const match = findById(
      getRegisteredForgeProviders().filter((p) =>
        forgeProviderServesRole(p.contribution, "issues")
      ),
      issueProviderOverride
    );
    return match ? { entry: match, resolvedVia: "override" } : NO_ISSUES;
  }
  return code.entry && forgeProviderServesRole(code.entry.contribution, "issues")
    ? { entry: code.entry, resolvedVia: "code" }
    : NO_ISSUES;
}

function codeProviders(providers: RegisteredForgeProvider[]): RegisteredForgeProvider[] {
  return providers.filter((p) => forgeProviderServesRole(p.contribution, "code"));
}

function findById(
  providers: RegisteredForgeProvider[],
  id: string
): RegisteredForgeProvider | undefined {
  // Prefer the canonical `{pluginId}.{contributionId}` form (#8451). The bare
  // `contribution.id` fallback stays for third-party plugins whose stored
  // overrides predate the canonicalization migration — `normalizeProviderId`
  // only rewrites the known built-in aliases and passes unknown strings
  // through unchanged, so a legacy `"gitea"` value would otherwise stop
  // resolving against an `acme.gitea` plugin.
  return providers.find(
    (p) => makeForgeProviderId(p.pluginId, p.contribution.id) === id || p.contribution.id === id
  );
}
