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
  const impl = getForgeProviderImpl(namespaceId);
  if (!impl) {
    throw new Error(
      `Forge provider "${resolved.entry.contribution.id}" not activated. Activate it in Settings.`
    );
  }

  const repoRef = impl.parseRemote(remoteUrl);
  if (!repoRef) {
    throw new Error("Could not parse repository identity from remote URL");
  }

  // Hand the provider the worktree this call pertains to so a file/CLI-backed
  // provider doesn't have to reconstruct it from `repo` (#10563). `cwd` may be a
  // linked-worktree subdirectory, so normalize to that worktree's top level.
  const projectPath = (await gitService.getRepositoryRoot(cwd).catch(() => null)) ?? cwd;

  return {
    namespaceId,
    providerId: resolved.entry.contribution.id,
    repoRef: { ...repoRef, projectPath },
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
