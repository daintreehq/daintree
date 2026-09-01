/**
 * Relays the forge provider hostname-matcher table from main's registry into
 * every workspace host, so worktree monitors can resolve remote URLs to a
 * registered provider id without registry access. Mirrors the fetch-throttle
 * relay: pushes on every registry change, and the pool cache seeds hosts
 * created later.
 */
import {
  listForgeProviderMatchers,
  onForgeProviderMatchersChanged,
} from "./forgeProviderRegistry.js";

let initialized = false;

async function pushMatchersToWorkspaceHosts(): Promise<void> {
  try {
    const { getWorkspaceClient } = await import("./WorkspaceClient.js");
    getWorkspaceClient().relayForgeProviderMatchers(listForgeProviderMatchers());
  } catch {
    // WorkspaceClient may not be initialized yet — hosts created later are
    // seeded from the pool cache, and the relay fires again on every change.
  }
}

export function initForgeMatcherRelay(): void {
  if (initialized) return;
  initialized = true;
  onForgeProviderMatchersChanged(() => {
    void pushMatchersToWorkspaceHosts();
  });
  // Initial push covers providers registered before the relay was wired.
  void pushMatchersToWorkspaceHosts();
}
