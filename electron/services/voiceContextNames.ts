import { projectStore } from "./ProjectStore.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { getRemoteService } from "../remote/runtime.js";
import { logDebug } from "../utils/logger.js";

const P = "[VoiceNames]";

/** The names a person speaks aloud to point at somewhere, spelled as Daintree shows them. */
export interface DictationNames {
  hosts: string[];
  projects: string[];
  worktrees: string[];
}

export const NO_DICTATION_NAMES: DictationNames = { hosts: [], projects: [], worktrees: [] };

export interface DictationNamesOpts {
  /** The view's project, when the terminal doesn't pin one. */
  projectId: string | null;
  terminalId?: string;
  ptyClient?: PtyClient;
  worktreeService?: WorkspaceClient;
}

// The Assistant is where hosts and projects are spoken; any other terminal
// only ever needs its own project's worktrees.
async function isAssistantTarget(ptyClient: PtyClient, terminalId: string): Promise<boolean> {
  try {
    const terminal = await ptyClient.getTerminalAsync(terminalId);
    return isAssistantTerminalRecord(terminal ?? { id: terminalId });
  } catch {
    return false;
  }
}

async function readWorktreeNames(
  projectId: string | null,
  worktreeService: WorkspaceClient | undefined
): Promise<string[]> {
  const project = projectId ? projectStore.getProjectById(projectId) : null;
  if (!project || !worktreeService) return [];
  const states = await worktreeService.getAllStatesForProjectAsync(project.path, project.id);
  // The main worktree is the project itself, whose name is already sent.
  return states.filter((wt) => !wt.isMainWorktree).map((wt) => wt.name);
}

export async function gatherDictationNames(opts: DictationNamesOpts): Promise<DictationNames> {
  const { terminalId, ptyClient, worktreeService } = opts;
  try {
    if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return NO_DICTATION_NAMES;
    const ownerId = ptyClient.getTerminalProjectId(terminalId) ?? opts.projectId;
    if (ownerId && opts.projectId && ownerId !== opts.projectId) return NO_DICTATION_NAMES;

    const assistant = await isAssistantTarget(ptyClient, terminalId);
    const worktrees = await readWorktreeNames(ownerId ?? null, worktreeService).catch(() => []);
    if (!assistant) return { hosts: [], projects: [], worktrees };

    const hosts = (getRemoteService("remoteHostsClient")?.list() ?? []).map(
      (entry) => entry.descriptor.name
    );
    const projects = projectStore.getProjectSummaries().map((project) => project.name);
    return { hosts, projects, worktrees };
  } catch {
    logDebug(`${P} Failed to gather names`);
    return NO_DICTATION_NAMES;
  }
}

export function flattenDictationNames(names: DictationNames): string[] {
  return [...names.hosts, ...names.projects, ...names.worktrees];
}
