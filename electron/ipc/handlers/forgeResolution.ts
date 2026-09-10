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
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
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
    // Deliberately not "no longer exists": the name may still be present but
    // carry no fetch URL (a push-only remote), which is equally unusable.
    super(
      `This project is set to use the "${remoteName}" remote, which isn't available. Pick a different remote in Project settings.`
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
  forgeRemote: string | null,
  forgeProviderOverride: string | null = null
): Promise<string | null> {
  const selected = await resolveEffectiveForgeRemote(
    gitService,
    cwd,
    forgeRemote,
    forgeProviderOverride
  );
  return selected?.fetchUrl ?? null;
}

/**
 * As {@link resolveEffectiveRemoteUrl}, but keeps the remote's *name*.
 *
 * Git operations that address the forge by remote name rather than URL —
 * fetching a PR head, which only exists on the repository the PR was opened
 * against (#11747) — need the name, and re-deriving it at those call sites
 * would let the precedence chain drift from the one the toolbar uses.
 * `resolveEffectiveRemoteUrl` delegates here so there is exactly one copy.
 *
 * Propagates {@link StaleForgeRemoteError} rather than falling back: a
 * configured-but-missing remote means we cannot tell which repository the user
 * meant, and PR numbers are per-repository, so substituting one would happily
 * fetch a completely unrelated PR that happens to share the number.
 */
export async function resolveEffectiveForgeRemote(
  gitService: RemoteReader,
  cwd: string,
  forgeRemote: string | null,
  forgeProviderOverride: string | null = null
): Promise<{ name: string; fetchUrl: string } | null> {
  const remotes = await gitService.listRemotes(cwd).catch(() => null);

  if (remotes === null) {
    if (forgeRemote) return null;
    const fetchUrl = await gitService.getRemoteUrl(cwd).catch(() => null);
    // The origin-only fallback path knows the URL but not a verified name;
    // `origin` is what `getRemoteUrl` reads, so it is the honest label.
    return fetchUrl ? { name: "origin", fetchUrl } : null;
  }

  const { remote, missingConfiguredRemote } = resolveForgeRemote({
    remotes,
    forgeRemote,
    // A per-project provider override deliberately bypasses hostname matching
    // (`forgeProviderResolver` searches the whole registry for it), so the
    // hostname registry must not get a veto over which remote we pick either.
    // Filtering here would discard a self-hosted origin the override exists to
    // support and hand the override's provider a sibling mirror instead.
    isSupportedRemote: forgeProviderOverride
      ? undefined
      : (url) => listMatchingProviders(url).length > 0,
  });
  if (missingConfiguredRemote) throw new StaleForgeRemoteError(missingConfiguredRemote);
  return remote ? { name: remote.name, fetchUrl: remote.fetchUrl } : null;
}

/**
 * Read the project-scoped forge settings that decide which remote to use.
 *
 * The cwd may be a linked-worktree subdirectory, so an exact match against
 * `project.path` would miss. `git worktree list` reports the main worktree
 * first from anywhere inside the repo — that path is what ProjectStore keys on.
 *
 * Resolved before any remote URL (#11408): the project's `forgeRemote` setting
 * decides *which* remote we read, so the settings have to be in hand first.
 */
async function readProjectForgeSettings(
  gitService: { listWorktrees(): Promise<Array<{ path: string; isMainWorktree?: boolean }>> } & {
    getRepositoryRoot(cwd: string): Promise<string | null>;
  },
  cwd: string
): Promise<{
  forgeRemote: string | null;
  forgeProviderOverride: string | null;
  /** Repo root the settings were keyed on — what `repoRef.projectPath` stamps (#10563). */
  mainWorktreePath: string;
}> {
  const worktrees = await gitService.listWorktrees().catch(() => []);
  const mainWorktreePath =
    worktrees.find((wt) => wt.isMainWorktree)?.path ??
    (await gitService.getRepositoryRoot(cwd).catch(() => null)) ??
    cwd;
  const project = await projectStore.getProjectByPath(mainWorktreePath).catch(() => null);
  // A registered project whose settings we cannot read is NOT the same as an
  // unregistered path: the former may well have a `forgeRemote` we are about to
  // ignore, and auto-detecting past it would point a mutation at whichever repo
  // origin happens to be. Only a genuinely absent project may auto-detect.
  let settings = null;
  if (project) {
    try {
      settings = await projectStore.getProjectSettings(project.id);
    } catch (error) {
      throw new Error(
        `Couldn't read this project's forge settings, so the remote to use is unknown: ${formatErrorMessage(error, "settings read failed")}`,
        { cause: error }
      );
    }
  }
  return {
    forgeRemote: settings?.forgeRemote ?? settings?.githubRemote ?? null,
    forgeProviderOverride: settings?.forgeProviderOverride ?? null,
    mainWorktreePath,
  };
}

/**
 * The forge remote's *name* for a cwd, for git commands that address the
 * forge by remote rather than URL (PR-head fetches, #11747).
 *
 * Deliberately lighter than {@link resolveForCwd}: it reads the remote table
 * and the project setting, and stops there. No provider matching, no lazy
 * plugin activation — a PR checkout doesn't need a live provider
 * implementation, and dragging one in would make the fetch depend on plugin
 * startup.
 */
export async function resolveForgeRemoteNameForCwd(cwd: string): Promise<string | null> {
  const gitService = gitServiceCache.getGitService(cwd);
  if (!gitService) return null;
  const { forgeRemote, forgeProviderOverride } = await readProjectForgeSettings(gitService, cwd);
  const selected = await resolveEffectiveForgeRemote(
    gitService,
    cwd,
    forgeRemote,
    forgeProviderOverride
  );
  if (selected) return selected.name;
  // `null` from a *configured* remote means enumeration failed, so we could
  // not verify the remote the user named — not that the repo has none. The
  // caller's fallback is `origin`, and PR numbers are per-repository: fetching
  // `origin pull/42/head` for a project pointed at `upstream` would silently
  // check out an unrelated PR that happens to share the number. Fail closed.
  if (forgeRemote) {
    throw new Error(
      `Couldn't confirm this project's "${forgeRemote}" remote, so the repository to fetch from is unknown. Check the remote and try again.`
    );
  }
  return null;
}

/**
 * Accept a provider's refspec only if it maps one source ref onto exactly the
 * branch the caller asked for. The provider owns the source hierarchy; the
 * destination is the host's, and this is where that stops being a convention.
 *
 * The value goes into `git fetch` argv, and git updates whatever destination it
 * is handed. Everything rejected here is something git would otherwise accept
 * and do:
 *
 *  - `...:refs/heads/main` fast-forwards an unrelated local branch. A leading
 *    `+` is not required for that, and outside `refs/heads/*` and `refs/tags/*`
 *    git takes even non-fast-forward updates without one.
 *  - `:feature/x` is not a delete on fetch the way it is on push — it fetches
 *    the remote's HEAD, so the worktree would be built on the default branch
 *    instead of the PR, silently and successfully.
 *  - `refs/merge-requests/42/head:` fetches the objects and creates no branch,
 *    which the host would still report as a successful fetch.
 *  - A leading `-` is parsed as an option rather than a refspec, which drops the
 *    mapping and lets the repo's configured fetch refspecs apply instead.
 *  - A `*` maps a whole hierarchy, writing refs nobody asked for.
 *
 * Whitespace is rejected rather than trimmed: a ref name cannot contain any, so
 * its presence means the provider built the string wrong, and trimming would
 * hide that. It also keeps JS whitespace semantics from quietly reshaping a ref
 * name git would have read differently.
 */
function isRefspecForBranch(refspec: string, headRefName: string): boolean {
  if (/^[+^-]/.test(refspec) || /\s/.test(refspec) || refspec.includes("*")) return false;
  const parts = refspec.split(":");
  if (parts.length !== 2) return false;
  const [src, dst] = parts;
  if (!src || !dst) return false;
  return dst === headRefName || dst === `refs/heads/${headRefName}`;
}

/**
 * The provider-shaped refspec that fetches a PR's head into `headRefName`, for
 * the checkout fallback that runs when the head branch isn't already local
 * (#12324). Resolved here, next to the remote name, so the workspace host never
 * gains a forge-provider dependency.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 *
 *  - a string — the provider's refspec, used verbatim.
 *  - `null` — the provider says this forge has no fetchable PR-head ref at all
 *    (Bitbucket Cloud). The caller reports that instead of fetching.
 *  - `undefined` — we could not find out. No provider is registered for this
 *    repo, none is installed, the plugin failed to activate, the capability is
 *    absent, or the builder threw or returned something unusable. The caller
 *    falls back to the GitHub-shaped default, which is exactly the pre-#12324
 *    behavior — a repo whose PR fetch worked before must never start failing
 *    because a *capability lookup* did (#10192).
 *
 * Unlike {@link resolveForgeRemoteNameForCwd} this does activate the provider:
 * the builder lives on the implementation, and there is no manifest-level
 * declaration to read instead. Deciding the refspec from whichever plugins
 * happen to be warm would make the same repo fetch differently run to run. The
 * cost is bounded — activation is coalesced by PluginService, and the caller
 * is about to do a network fetch regardless.
 *
 * Callers must resolve the remote name BEFORE calling this. That call fails
 * closed on a stale or unverifiable remote, and this function's catch-all would
 * otherwise swallow the same failure into a silent GitHub-shaped fallback.
 */
export async function resolvePRHeadRefspecForCwd(
  cwd: string,
  prNumber: number,
  headRefName: string
): Promise<string | null | undefined> {
  let refspec: string | null;
  try {
    const { impl } = await resolveForCwd(cwd);
    // Truthiness, never `in`: a capability explicitly set to `undefined` still
    // satisfies `in` and would be called as a non-function.
    if (!impl.buildPRHeadRefspec) return undefined;
    refspec = impl.buildPRHeadRefspec(prNumber, headRefName);
  } catch {
    return undefined;
  }
  if (refspec === null) return null;
  // A provider bug must not become a surprising local-ref write, so anything
  // that doesn't land on exactly the requested branch degrades to the default.
  if (typeof refspec !== "string" || !isRefspecForBranch(refspec, headRefName)) return undefined;
  return refspec;
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
  const { forgeRemote, forgeProviderOverride, mainWorktreePath } = await readProjectForgeSettings(
    gitService,
    cwd
  );

  const remoteUrl = await resolveEffectiveRemoteUrl(
    gitService,
    cwd,
    forgeRemote,
    forgeProviderOverride
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

/**
 * Impl lookup with the same implicit activation as {@link resolveForCwd}, for
 * provider-scoped surfaces that address a provider by id instead of a cwd
 * (credential save, token test). Lazy plugins only bind their impl during
 * activate(), and connecting a provider for the first time is exactly the
 * moment nothing else has activated it yet — without this, Save/Test on a
 * fresh session fails with "not activated" while the user is standing in the
 * Settings screen that's supposed to activate it.
 */
export async function getImplForNamespaceActivating(
  namespaceId: string
): Promise<ForgeProviderImpl | undefined> {
  const existing = getForgeProviderImpl(namespaceId);
  if (existing) return existing;
  const pluginService = await getPluginService();
  await pluginService.activatePluginForForgeProvider(namespaceId);
  return getForgeProviderImpl(namespaceId);
}
