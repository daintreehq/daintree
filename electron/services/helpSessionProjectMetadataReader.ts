import { projectStore } from "./ProjectStore.js";
import { getEffectiveRegistry } from "../../shared/config/agentRegistry.js";
import {
  LAUNCHABLE_AGENT_IDS,
  isAssistantOnlyAgentId,
  isBuiltInAgentId,
} from "../../shared/config/agentIds.js";
import { isAgentLaunchable } from "../../shared/utils/agentAvailability.js";
import type { CliAvailability } from "../../shared/types/ipc/system.js";
import { gitServiceCache } from "./GitServiceCache.js";
import { listMatchingProviders } from "./forgeProviderRegistry.js";
import { resolveForgeRemote } from "../../shared/utils/forgeRemoteSelection.js";
import {
  sanitizeGitRemoteUrl,
  type HelpSessionAgentsFact,
  type HelpSessionProjectFacts,
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
  projectPath: string,
  mainWorktreePath: string
): Promise<HelpSessionProjectFacts["forgeRemote"]> {
  // Settings are keyed on the main worktree's project, exactly as the forge
  // toolbar resolves them (`readProjectForgeSettings`), so a project opened on
  // a linked worktree reports the remote its forge actions actually use.
  const project = await projectStore.getProjectByPath(mainWorktreePath);
  const settings = project ? await projectStore.getProjectSettings(project.id) : null;
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

/**
 * The agents a launch accepts, in `agent.listAvailable`'s order: built-ins,
 * then user and plugin agents by id. Once the CLIs have been probed only the
 * launchable ones are listed; before that, every registered one is.
 */
export function listLaunchableAgents(availability: CliAvailability | null): HelpSessionAgentsFact {
  const registry = getEffectiveRegistry();
  const ids = [
    ...LAUNCHABLE_AGENT_IDS.filter((id) => Object.hasOwn(registry, id)),
    ...Object.keys(registry)
      .filter((id) => !isBuiltInAgentId(id) && !isAssistantOnlyAgentId(id))
      .sort(),
  ];
  return {
    agents: ids
      .filter((id) => availability === null || isAgentLaunchable(availability[id]))
      .map((id) => ({ id, name: registry[id]?.name ?? id })),
    availabilityChecked: availability !== null,
  };
}

export async function readHelpSessionProjectFacts(
  projectId: string,
  projectPath: string,
  readAvailability: () => CliAvailability | null = () => null
): Promise<HelpSessionProjectFacts> {
  const facts: HelpSessionProjectFacts = {};
  try {
    facts.launchableAgents = listLaunchableAgents(readAvailability());
  } catch (err) {
    warnLookupFailed("agents", err);
  }
  try {
    const name = projectStore.getProjectById(projectId)?.name;
    if (name) facts.name = name;
  } catch (err) {
    warnLookupFailed("name", err);
  }

  const listed = await gitServiceCache
    .getGitService(projectPath)
    .listWorktrees()
    .catch((err: unknown) => {
      warnLookupFailed("worktrees", err);
      return null;
    });
  if (listed) {
    // A bare entry is the backing repository, not a working tree anyone can open.
    facts.worktrees = listed
      .filter((wt) => !wt.bare)
      .map((wt) => ({ path: wt.path, branch: wt.branch, isMainWorktree: wt.isMainWorktree }));
  }

  const mainWorktreePath = listed?.find((wt) => wt.isMainWorktree)?.path ?? projectPath;
  const forgeRemote = await readForgeRemote(projectPath, mainWorktreePath).catch((err: unknown) => {
    warnLookupFailed("forgeRemote", err);
    return undefined;
  });
  if (forgeRemote) facts.forgeRemote = forgeRemote;
  return facts;
}
