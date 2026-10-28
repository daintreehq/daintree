import { projectStore } from "./ProjectStore.js";
import { isAssistantTerminalRecord } from "./assistantTerminal.js";
import { subagentTerminalAgentId } from "./subagentTerminalAgent.js";
import type { PtyClient } from "./PtyClient.js";
import type { WorkspaceClient } from "./WorkspaceClient.js";
import { getRemoteService } from "../remote/runtime.js";
import { logDebug } from "../utils/logger.js";
import { pathComparisonKey, resolveWorktreePathScope } from "../../shared/utils/path.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";

const P = "[VoiceNames]";
// Their folders are the same whatever the case, or Unicode form, a path spells
// them in. Elsewhere two spellings are two folders.
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

/** The names a person speaks aloud to point at somewhere, spelled as Daintree shows them. */
export interface DictationNames {
  hosts: string[];
  projects: string[];
  worktrees: string[];
}

export const NO_DICTATION_NAMES: DictationNames = { hosts: [], projects: [], worktrees: [] };

/** The worktree a dictation is typed in, as its record has it: never fetched for this. */
export interface DictationWorktree {
  name: string;
  issueTitle?: string;
  prTitle?: string;
  branchDerivedTitle?: string;
}

/** The names a dictation may speak, and the worktree it is typed in when main can tell. */
export interface DictationContext {
  names: DictationNames;
  worktree: DictationWorktree | null;
}

export const NO_DICTATION_CONTEXT: DictationContext = { names: NO_DICTATION_NAMES, worktree: null };

export interface DictationNamesOpts {
  /** The view's project, when the terminal doesn't pin one. */
  projectId: string | null;
  terminalId?: string;
  ptyClient?: PtyClient;
  worktreeService?: WorkspaceClient;
}

type TerminalKind = "assistant" | "agent" | "other";

interface TerminalPlace {
  kind: TerminalKind;
  worktreeId: string | null;
  cwd: string | null;
}

// Hosts and projects are spoken to the Assistant and to agents; a plain shell
// only ever needs its own project's worktrees. An unreadable record is a shell
// filed under no worktree.
async function readTerminalPlace(ptyClient: PtyClient, terminalId: string): Promise<TerminalPlace> {
  try {
    const terminal = await ptyClient.getTerminalAsync(terminalId);
    const worktreeId = typeof terminal?.worktreeId === "string" ? terminal.worktreeId : null;
    const cwd = typeof terminal?.cwd === "string" ? terminal.cwd : null;
    if (isAssistantTerminalRecord(terminal ?? { id: terminalId })) {
      return { kind: "assistant", worktreeId, cwd };
    }
    const kind = terminal && subagentTerminalAgentId(terminal) ? "agent" : "other";
    return { kind, worktreeId, cwd };
  } catch {
    return { kind: "other", worktreeId: null, cwd: null };
  }
}

async function readWorktreeStates(
  projectId: string | null,
  worktreeService: WorkspaceClient | undefined
): Promise<WorktreeSnapshot[]> {
  const project = projectId ? projectStore.getProjectById(projectId) : null;
  if (!project || !worktreeService) return [];
  return worktreeService.getAllStatesForProjectAsync(project.path, project.id);
}

// The worktree the terminal is filed under, whose id is its path; a move
// updates it while the spawn cwd stays put, so a filed terminal whose worktree
// is gone has none rather than its old cwd's. One filed under none is placed
// by its cwd, the deepest worktree holding it winning.
function findTerminalWorktree(
  states: readonly WorktreeSnapshot[],
  place: TerminalPlace
): WorktreeSnapshot | null {
  if (place.worktreeId) return states.find((wt) => wt.id === place.worktreeId) ?? null;
  // Refused before folding, which would collapse a `..` the resolver refuses
  // because a symlink can put it somewhere else entirely.
  if (!place.cwd || place.cwd.split(/[\\/]/).includes("..")) return null;
  const key = CASE_INSENSITIVE_PATHS
    ? (path: string) => pathComparisonKey(path, { caseInsensitive: true })
    : (path: string) => path;
  const scope = resolveWorktreePathScope(
    key(place.cwd),
    states.map((wt) => ({ id: wt.id, path: key(wt.path) }))
  );
  return scope ? (states.find((wt) => wt.id === scope.worktreeId) ?? null) : null;
}

function dictationWorktreeOf(state: WorktreeSnapshot | null): DictationWorktree | null {
  if (!state) return null;
  return {
    name: state.name,
    ...(state.issueTitle ? { issueTitle: state.issueTitle } : {}),
    ...(state.prTitle ? { prTitle: state.prTitle } : {}),
    ...(state.branchDerivedTitle ? { branchDerivedTitle: state.branchDerivedTitle } : {}),
  };
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
  return (await gatherDictationContext(opts)).names;
}

/**
 * The names, and the worktree the terminal is in, from the same two reads:
 * the terminal's record and the worktree states its project's host already
 * holds. Titles are what the record has; nothing is fetched for them.
 */
export async function gatherDictationContext(opts: DictationNamesOpts): Promise<DictationContext> {
  const { terminalId, ptyClient, worktreeService } = opts;
  try {
    if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return NO_DICTATION_CONTEXT;
    const ownerId = ptyClient.getTerminalProjectId(terminalId) ?? opts.projectId;
    if (ownerId && opts.projectId && ownerId !== opts.projectId) return NO_DICTATION_CONTEXT;

    const place = await readTerminalPlace(ptyClient, terminalId);
    const states = await readWorktreeStates(ownerId ?? null, worktreeService).catch(
      (): WorktreeSnapshot[] => []
    );
    // The main worktree is the project itself, whose name is already sent.
    const worktrees = states.filter((wt) => !wt.isMainWorktree).map((wt) => wt.name);
    const { kind } = place;
    // The Assistant speaks for every project rather than working in one tree.
    const worktree =
      kind === "assistant" ? null : dictationWorktreeOf(findTerminalWorktree(states, place));
    if (kind === "other") return { names: { hosts: [], projects: [], worktrees }, worktree };

    // A failed read costs an agent pane its hosts and projects, not the
    // worktrees it had before; the Assistant keeps giving up on all of them.
    let spoken: Pick<DictationNames, "hosts" | "projects"> = { hosts: [], projects: [] };
    try {
      spoken = readHostsAndProjects(kind === "assistant" ? null : (ownerId ?? null));
    } catch (error) {
      if (kind === "assistant") throw error;
      logDebug(`${P} Failed to read hosts and projects`);
    }
    return { names: { ...spoken, worktrees }, worktree };
  } catch {
    logDebug(`${P} Failed to gather names`);
    return NO_DICTATION_CONTEXT;
  }
}

export function flattenDictationNames(names: DictationNames): string[] {
  return [...names.hosts, ...names.projects, ...names.worktrees];
}
