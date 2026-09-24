import { projectStore } from "./ProjectStore.js";
import { gitServiceCache } from "./GitServiceCache.js";
import { listMatchingProviders } from "./forgeProviderRegistry.js";
import { resolveForgeRemote } from "../../shared/utils/forgeRemoteSelection.js";
import {
  sanitizeGitRemoteUrl,
  type HelpSessionProjectFacts,
  type HelpSessionWorktreeFact,
} from "./helpSessionProjectMetadata.js";

// Lookup failures are logged by name only: git errors can echo the remote URL,
// and an HTTPS remote may carry a token in it.
function warnLookupFailed(lookup: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  console.warn(
    `[HelpSessionService] Project metadata lookup "${lookup}" failed; omitting it${code ? ` (${code})` : ""}`
  );
}

async function readForgeRemote(
  projectId: string,
  projectPath: string
): Promise<HelpSessionProjectFacts["forgeRemote"]> {
  const settings = await projectStore.getProjectSettings(projectId);
  const forgeRemote = settings?.forgeRemote ?? settings?.githubRemote ?? null;
  const override = settings?.forgeProviderOverride ?? null;
  const remotes = await gitServiceCache.getGitService(projectPath).listRemotes(projectPath);
  // Same selection the forge toolbar uses, minus provider activation: a
  // provider override bypasses hostname matching there, so it does here too.
  const { remote } = resolveForgeRemote({
    remotes,
    forgeRemote,
    isSupportedRemote: override ? undefined : (url) => listMatchingProviders(url).length > 0,
  });
  if (!remote) return undefined;
  const url = sanitizeGitRemoteUrl(remote.fetchUrl);
  return url ? { name: remote.name, url } : undefined;
}

async function readWorktrees(projectPath: string): Promise<HelpSessionWorktreeFact[]> {
  const worktrees = await gitServiceCache.getGitService(projectPath).listWorktrees();
  // A bare entry is the backing repository, not a working tree anyone can open.
  return worktrees
    .filter((wt) => !wt.bare)
    .map((wt) => ({ path: wt.path, branch: wt.branch, isMainWorktree: wt.isMainWorktree }));
}

export async function readHelpSessionProjectFacts(
  projectId: string,
  projectPath: string
): Promise<HelpSessionProjectFacts> {
  const facts: HelpSessionProjectFacts = {};
  try {
    const name = projectStore.getProjectById(projectId)?.name;
    if (name) facts.name = name;
  } catch (err) {
    warnLookupFailed("name", err);
  }

  const [worktrees, forgeRemote] = await Promise.all([
    readWorktrees(projectPath).catch((err: unknown) => {
      warnLookupFailed("worktrees", err);
      return undefined;
    }),
    readForgeRemote(projectId, projectPath).catch((err: unknown) => {
      warnLookupFailed("forgeRemote", err);
      return undefined;
    }),
  ]);
  if (worktrees) facts.worktrees = worktrees;
  if (forgeRemote) facts.forgeRemote = forgeRemote;
  return facts;
}
