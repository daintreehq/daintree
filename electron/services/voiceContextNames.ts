import { projectStore } from "./ProjectStore.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { subagentTerminalAgentId } from "./subagentTerminalAgent.js";
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

type TerminalKind = "assistant" | "agent" | "other";

// Hosts and projects are spoken to the Assistant and to agents; a plain shell
// only ever needs its own project's worktrees. An unreadable record is a shell.
async function readTerminalKind(ptyClient: PtyClient, terminalId: string): Promise<TerminalKind> {
  try {
    const terminal = await ptyClient.getTerminalAsync(terminalId);
    if (isAssistantTerminalRecord(terminal ?? { id: terminalId })) return "assistant";
    return terminal && subagentTerminalAgentId(terminal) ? "agent" : "other";
  } catch {
    return "other";
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

function readHostsAndProjects(excludeProjectId: string | null) {
  const hosts = (getRemoteService("remoteHostsClient")?.list() ?? []).map(
    (entry) => entry.descriptor.name
  );
  // Most used first, which is the order the screen's cap keeps. A pane's own
  // project is already sent whole as the project tier, so it would only spend a
  // name slot; the Assistant lists it, as it always has.
  const projects = projectStore
    .getProjectSummaries()
    .filter((project) => project.id !== excludeProjectId)
    .map((project) => project.name);
  return { hosts, projects };
}

export async function gatherDictationNames(opts: DictationNamesOpts): Promise<DictationNames> {
  const { terminalId, ptyClient, worktreeService } = opts;
  try {
    if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return NO_DICTATION_NAMES;
    const ownerId = ptyClient.getTerminalProjectId(terminalId) ?? opts.projectId;
    if (ownerId && opts.projectId && ownerId !== opts.projectId) return NO_DICTATION_NAMES;

    const kind = await readTerminalKind(ptyClient, terminalId);
    const worktrees = await readWorktreeNames(ownerId ?? null, worktreeService).catch(() => []);
    if (kind === "other") return { hosts: [], projects: [], worktrees };

    // A failed read costs an agent pane its hosts and projects, not the
    // worktrees it had before; the Assistant keeps giving up on all of them.
    let spoken: Pick<DictationNames, "hosts" | "projects"> = { hosts: [], projects: [] };
    try {
      spoken = readHostsAndProjects(kind === "assistant" ? null : (ownerId ?? null));
    } catch (error) {
      if (kind === "assistant") throw error;
      logDebug(`${P} Failed to read hosts and projects`);
    }
    return { ...spoken, worktrees };
  } catch {
    logDebug(`${P} Failed to gather names`);
    return NO_DICTATION_NAMES;
  }
}

export function flattenDictationNames(names: DictationNames): string[] {
  return [...names.hosts, ...names.projects, ...names.worktrees];
}
