// Authoritative "is GitHub usable right now" predicate for main-process code.
//
// GitHub functionality lives in the `daintree.github` built-in plugin. Its
// forge-provider impl is bound into the registry during plugin `activate()`
// and removed on disable/unload, so `getForgeProviderImpl(...) !== undefined`
// is the single source of truth for whether GitHub is active — it tracks the
// user's enable/disable choice without reaching into PluginService state.
//
// This helper deliberately imports the registry (host-owned), NOT the github
// plugin barrel, so callers can gate on availability without forcing the
// plugin module to load.
import { getForgeProviderImpl } from "../forgeProviderRegistry.js";
import { BUILTIN_GITHUB_PROVIDER_ID } from "../../../shared/utils/forgeProviderIds.js";

/** True when the built-in GitHub forge provider is registered and activated. */
export function isGitHubProviderActive(): boolean {
  return getForgeProviderImpl(BUILTIN_GITHUB_PROVIDER_ID) !== undefined;
}

/**
 * Thrown by native `github:*` data/network handlers when the GitHub plugin is
 * disabled. The `code` lets the renderer distinguish "provider off" from token
 * or network failures — though the renderer normally gates proactively on the
 * availability signal, so this is a backstop for direct/agent IPC callers.
 */
export class GitHubProviderUnavailableError extends Error {
  readonly code = "FORGE_PROVIDER_UNAVAILABLE";
  constructor() {
    super("GitHub is disabled. Enable the GitHub plugin to use this feature.");
    this.name = "GitHubProviderUnavailableError";
  }
}

/** Throw {@link GitHubProviderUnavailableError} unless the GitHub provider is active. */
export function assertGitHubProviderActive(): void {
  if (!isGitHubProviderActive()) throw new GitHubProviderUnavailableError();
}
