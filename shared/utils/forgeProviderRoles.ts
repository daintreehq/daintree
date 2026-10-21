import type {
  ForgeIssueProviderSelection,
  ForgeProviderContribution,
  ForgeProviderRole,
  ResolvedForgeProvider,
} from "../types/forge.js";

/** Roles a contribution serves when its manifest omits `roles`. */
export const DEFAULT_FORGE_PROVIDER_ROLES: readonly ForgeProviderRole[] = Object.freeze([
  "issues",
  "code",
]);

export function forgeProviderRoles(
  contribution: Pick<ForgeProviderContribution, "roles">
): readonly ForgeProviderRole[] {
  return contribution.roles && contribution.roles.length > 0
    ? contribution.roles
    : DEFAULT_FORGE_PROVIDER_ROLES;
}

export function forgeProviderServesRole(
  contribution: Pick<ForgeProviderContribution, "roles">,
  role: ForgeProviderRole
): boolean {
  return forgeProviderRoles(contribution).includes(role);
}

/**
 * The issues half of a resolution. A result without one predates roles (or is
 * a bare `{ entry, resolvedVia }` fallback), and there the code provider served
 * issues — exactly what the resolver returns when no issues override is set.
 */
export function issuesSelection(resolved: ResolvedForgeProvider): ForgeIssueProviderSelection {
  if (resolved.issues) return resolved.issues;
  return resolved.entry && forgeProviderServesRole(resolved.entry.contribution, "issues")
    ? { entry: resolved.entry, resolvedVia: "code" }
    : { entry: null, resolvedVia: null };
}
