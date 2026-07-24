// eager-import-allow: reads forge-resolution config via store.get synchronously in the IPC handler
import path from "node:path";
import { store } from "../../store.js";
import {
  getForgeProviderImpl,
  listMatchingProviders,
} from "../../services/forgeProviderRegistry.js";
import { resolveForgeProvider } from "../../services/forgeProviderResolver.js";
import { resolveForgeRemote } from "../../../shared/utils/forgeRemoteSelection.js";
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

/** The subset of `GitService` remote selection needs. */
interface RemoteReader {
  getRemoteUrl(repoPath: string): Promise<string | null>;
  listRemotes(repoPath: string): Promise<Array<{ name: string; fetchUrl: string }>>;
}

/** Thrown when `forgeRemote` names a remote the repo no longer has. */
export class StaleForgeRemoteError extends Error {
  constructor(readonly remoteName: string) {
    super(
      `This project is set to use the "${remoteName}" remote, which no longer exists. Pick a different remote in Project settings.`
    );
    this.name = "StaleForgeRemoteError";
  }
}

/**
 * Read the repo's remote table and pick the one the forge integration should
 * use, honouring the project's `forgeRemote` setting (#11408). Shared by
 * `resolveForCwd` and the `FORGE_RESOLVE_PROVIDER` handler so the pill's
 * visibility gate and the data it gates can never disagree about which remote
 * is live.
 *
 * Two deliberate asymmetries:
 *
 *  - A configured-but-missing remote throws {@link StaleForgeRemoteError}
 *    rather than auto-detecting. `resolveForCwd` backs mutations, so silently
 *    retargeting a renamed remote could push a write at the wrong repository.
 *  - Enumeration failure falls back to the origin-only lookup ONLY when no
 *    remote was configured. With a configured remote we cannot tell whether it
 *    still exists, and substituting origin has the same wrong-repo risk. This
 *    keeps the no-setting path byte-identical to the pre-fix behavior, so no
 *    project that resolved before can start reading as "no provider" and wipe
 *    the toolbar's persisted counts.
 */
export async function resolveEffectiveRemoteUrl(
  gitService: RemoteReader,
  cwd: string,
  forgeRemote: string | null
): Promise<string | null> {
  const remotes = await gitService.listRemotes(cwd).catch(() => null);

  if (remotes === null) {
    if (forgeRemote) return null;
    return gitService.getRemoteUrl(cwd).catch(() => null);
  }

  const { remote, missingConfiguredRemote } = resolveForgeRemote({
    remotes,
    forgeRemote,
    isSupportedRemote: (url) => listMatchingProviders(url).length > 0,
  });
  if (missingConfiguredRemote) throw new StaleForgeRemoteError(missingConfiguredRemote);
  return remote?.fetchUrl ?? null;
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

  // The cwd may be a linked-worktree subdirectory, so an exact match against
  // `project.path` would miss. `git worktree list` reports the main worktree
  // first from anywhere inside the repo — that path is what ProjectStore keys on.
  //
  // Resolved before the remote URL (#11408): the project's `forgeRemote`
  // setting decides *which* remote we read, so the settings have to be in hand
  // first. Previously this block ran after an origin-only `getRemoteUrl`, which
  // is why the setting never reached the toolbar's data path.
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

  const remoteUrl = await resolveEffectiveRemoteUrl(
    gitService,
    cwd,
    settings?.forgeRemote ?? settings?.githubRemote ?? null
  );
  if (!remoteUrl) {
    throw new Error("No remote URL found for this repository");
  }

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
