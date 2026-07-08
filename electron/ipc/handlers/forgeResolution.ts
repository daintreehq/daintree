// eager-import-allow: reads forge-resolution config via store.get synchronously in the IPC handler
import path from "node:path";
import { store } from "../../store.js";
import { getForgeProviderImpl } from "../../services/forgeProviderRegistry.js";
import { resolveForgeProvider } from "../../services/forgeProviderResolver.js";
import { gitServiceCache } from "../../services/GitServiceCache.js";
import { projectStore } from "../../services/ProjectStore.js";
import type { ForgeProviderImpl, RepoRef } from "../../../shared/types/forge.js";
import {
  makeForgeProviderId,
  normalizeProviderId,
} from "../../../shared/utils/forgeProviderIds.js";

// PluginService is loaded lazily (mirrors forgeRpcServer) so this eagerly
// registered handler module never constructs the singleton at import time.
type PluginActivator = { activatePluginForForgeProvider(namespacedId: string): Promise<void> };
let pluginServicePromise: Promise<PluginActivator> | null = null;
function getPluginService(): Promise<PluginActivator> {
  pluginServicePromise ??= import("../../services/PluginService.js").then((m) => m.pluginService);
  return pluginServicePromise;
}

/**
 * Shared `cwd → forge provider` resolution. Both the action handlers
 * (`forge.ts` — open/assign) and the data handlers (`forgeData.ts` —
 * list/get) resolve the same way: remote URL → registered provider →
 * activated implementation → parsed {@link RepoRef}. Keeping one copy
 * means the precedence chain can't drift between the two surfaces.
 *
 * `impl` is returned alongside so data handlers don't need a second
 * registry lookup per call.
 */
export interface ResolvedForgeContext {
  namespaceId: string;
  /** The resolved provider's `contribution.id` — also the settings subtab key. */
  providerId: string;
  repoRef: RepoRef;
  impl: ForgeProviderImpl;
}

export async function resolveForCwd(cwd: string): Promise<ResolvedForgeContext> {
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("Invalid working directory");
  }
  if (!path.isAbsolute(cwd)) {
    throw new Error("Working directory must be an absolute path");
  }

  const gitService = gitServiceCache.getGitService(cwd);
  if (!gitService) {
    throw new Error("Not a git repository");
  }

  const remoteUrl = await gitService.getRemoteUrl(cwd).catch(() => null);
  if (!remoteUrl) {
    throw new Error("No remote URL found for this repository");
  }

  // The cwd may be a linked-worktree subdirectory, so an exact match against
  // `project.path` would miss. `git worktree list` reports the main worktree
  // first from anywhere inside the repo — that path is what ProjectStore keys on.
  const worktrees = await gitService.listWorktrees().catch(() => []);
  const mainWorktreePath =
    worktrees.find((wt) => wt.isMainWorktree)?.path ??
    (await gitService.getRepositoryRoot(cwd).catch(() => null)) ??
    cwd;
  const project = await projectStore.getProjectByPath(mainWorktreePath).catch(() => null);
  const settings = project
    ? await projectStore.getProjectSettings(project.id).catch(() => null)
    : null;
  const forgeProviderOverride = settings?.forgeProviderOverride ?? null;

  const globalDefaultProviderId = normalizeProviderId(store.get("forgeDefaultProviderId"));

  const resolved = resolveForgeProvider({
    remoteUrl,
    forgeProviderOverride,
    globalDefaultProviderId,
  });

  if (!resolved.entry) {
    throw new Error("No forge provider registered for this repository");
  }

  const namespaceId = makeForgeProviderId(resolved.entry.pluginId, resolved.entry.contribution.id);
  let impl = getForgeProviderImpl(namespaceId);
  if (!impl) {
    // Implicit activation, mirroring the forge RPC server: lazy plugins
    // (no `activationEvents`, #10523) only bind their impl during activate(),
    // and nothing on this IPC path triggered it. Without this, every cold-start
    // stats/list call fails until some other surface (workspace-host PR
    // monitoring) happens to activate the plugin — the toolbar counts then sit
    // empty until the next 30s poll (30–60s after launch).
    const pluginService = await getPluginService();
    await pluginService.activatePluginForForgeProvider(namespaceId);
    impl = getForgeProviderImpl(namespaceId);
  }
  if (!impl) {
    throw new Error(
      `Forge provider "${resolved.entry.contribution.id}" not activated. Activate it in Settings.`
    );
  }

  const repoRef = impl.parseRemote(remoteUrl);
  if (!repoRef) {
    throw new Error("Could not parse repository identity from remote URL");
  }

  // Hand the provider the project's on-disk root so a file/CLI-backed provider
  // doesn't have to reconstruct it from `repo` (#10563). `mainWorktreePath` is
  // already the project root (resolved above for the ProjectStore lookup), which
  // matches the project-root path `PullRequestService` stamps on the RPC path.
  return {
    namespaceId,
    providerId: resolved.entry.contribution.id,
    repoRef: { ...repoRef, projectPath: mainWorktreePath },
    impl,
  };
}

export function getImplForNamespace(namespaceId: string): ForgeProviderImpl {
  const impl = getForgeProviderImpl(namespaceId);
  if (!impl) {
    throw new Error(`Forge provider "${namespaceId}" not activated. Activate it in Settings.`);
  }
  return impl;
}
