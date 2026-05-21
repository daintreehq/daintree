/**
 * Canonical forge provider IDs.
 *
 * A registered forge provider's runtime id is `{pluginId}.{contributionId}` —
 * the impl registry keys, IPC payloads, codec values, and renderer comparisons
 * all need to agree on this shape (#8451). Three legacy forms still appear in
 * persisted data: bare `"github"`, `"builtin.github"` from before the plugin
 * was renamed to `daintree.github`, and the canonical form itself. Normalize
 * those at read boundaries so the rest of the codebase only ever sees the
 * canonical id.
 *
 * Lives in `shared/` so the main process, the workspace-host UtilityProcess,
 * and the renderer can all import the same constant + helpers without dragging
 * any runtime bindings across the process boundary.
 */

/**
 * Build a canonical forge provider id from its plugin and contribution parts.
 * The `const` type parameters preserve the literal types so callers that pass
 * string literals get a precise template literal return type — useful for the
 * built-in constant below, and for any future built-ins that want type-level
 * proof of their id.
 */
export function makeForgeProviderId<const P extends string, const C extends string>(
  pluginId: P,
  contributionId: C
): `${P}.${C}` {
  return `${pluginId}.${contributionId}`;
}

/** Canonical id of the built-in GitHub forge provider. */
export const BUILTIN_GITHUB_PROVIDER_ID = makeForgeProviderId("daintree.github", "github");

export type BuiltInForgeProviderId = typeof BUILTIN_GITHUB_PROVIDER_ID;

/**
 * Open union — built-in ids autocomplete while still allowing any
 * `{pluginId}.{contributionId}` string from third-party plugins. The
 * `(string & {})` branch keeps the literal members visible (collapsing to
 * `string` would erase the autocomplete benefit). Precedent: PR #4489 used
 * the same pattern for action ids.
 */
export type ForgeProviderId = BuiltInForgeProviderId | (string & {});

/**
 * Map known legacy id forms to their canonical equivalent. Unknown non-empty
 * strings pass through unchanged — third-party providers may have stored ids
 * we do not recognize, and silently rewriting them would clear valid overrides.
 *
 * Returns `null` for non-string, empty, or whitespace-only inputs so callers
 * can treat the result as "no provider override" without a second guard.
 */
export function normalizeProviderId(raw: unknown): ForgeProviderId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "github" || trimmed === "builtin.github") {
    return BUILTIN_GITHUB_PROVIDER_ID;
  }
  return trimmed;
}
