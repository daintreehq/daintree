import { isAbsolute } from "node:path";
import type { VoiceDictionaryEntry } from "../../../shared/types/ipc/api.js";
import { logDebug } from "../../utils/logger.js";
import { fileSearchService } from "../FileSearchService.js";
import { projectStore } from "../ProjectStore.js";
import type { PtyClient } from "../PtyClient.js";
import type { WorkspaceClient } from "../WorkspaceClient.js";
import { readProjectVoiceDictionary } from "../projectVoiceDictionary.js";
import { FILE_LINK_CANDIDATE_LIMIT } from "../VoiceFileLinkResolver.js";
import { resolveVoiceCommandTarget, type VoiceCommandTarget } from "../voiceCommandTarget.js";
import {
  NO_PANE_KEYTERM_READS,
  readPaneKeytermReads,
  screenDictationNames,
  type PaneKeytermReads,
} from "../voiceContextKeyterms.js";
import {
  gatherDictationNames,
  NO_DICTATION_NAMES,
  type DictationNames,
} from "../voiceContextNames.js";
import {
  readTerminalOutputForCorrection,
  TERMINAL_READ_BUDGET_MS,
} from "../voiceTerminalContext.js";

export function getProjectInfo(projectId: string | null): { name?: string; path?: string } {
  const currentProject = projectId ? projectStore.getProjectById(projectId) : null;
  if (!currentProject) return {};
  return { name: currentProject.name, path: currentProject.path };
}

// Automatic hints come only from the terminal being dictated into: its output,
// its worktree's branch, its owning project's name, and names read from that
// project's repository (package, workspace, directory and dependency names).
// All of them are sent to the transcription provider. A terminal main doesn't
// track, or one another project owns than the view asking, contributes none.
export function resolveKeytermTarget(
  viewProjectId: string | null,
  terminalId: string | undefined,
  ptyClient: PtyClient | undefined
): { terminalId?: string; projectName?: string; projectPath?: string } {
  if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return {};
  const ownerId = ptyClient.getTerminalProjectId(terminalId);
  if (ownerId && viewProjectId && ownerId !== viewProjectId) return {};
  const project = ownerId ? projectStore.getProjectById(ownerId) : undefined;
  return { terminalId, projectName: project?.name, projectPath: project?.path };
}

// References resolve in the worktree the dictated terminal is filed under,
// else its cwd, as keyterms do. Without a terminal main can vouch for, the
// starting view's project; a view that owns no project resolves nothing, never
// the app's current one (#14599).
export async function resolveFileLinkCwd(
  viewProjectId: string | null,
  terminalId: string | undefined,
  viewProjectPath: string | null,
  ptyClient: PtyClient | undefined
): Promise<string | null> {
  const target = resolveKeytermTarget(viewProjectId, terminalId, ptyClient);
  if (target.terminalId && ptyClient) {
    const terminal = await ptyClient.getTerminalAsync(target.terminalId).catch(() => null);
    const path = terminal?.worktreeId ?? terminal?.cwd;
    if (typeof path === "string" && isAbsolute(path)) return path;
  }
  return viewProjectPath;
}

// The project whose vocabulary a dictation uses: the one that owns the target
// terminal, or the asking view's own for a panel main doesn't track as a
// terminal. A terminal another project owns than the view asking gets none,
// so a project's rules never reach dictation outside its own panels.
export function resolveVocabularyProject(
  viewProjectId: string | null,
  terminalId: string | undefined,
  ptyClient: PtyClient | undefined
): string | null {
  if (!terminalId || !ptyClient?.hasTerminal(terminalId)) return viewProjectId;
  const ownerId = ptyClient.getTerminalProjectId(terminalId);
  if (ownerId && viewProjectId && ownerId !== viewProjectId) return null;
  return ownerId ?? viewProjectId;
}

// An unreadable vocabulary leaves dictation with the global dictionary alone.
export async function readVocabulary(projectId: string | null): Promise<VoiceDictionaryEntry[]> {
  if (!projectId) return [];
  try {
    return await readProjectVoiceDictionary(projectId);
  } catch {
    logDebug("[VoiceInput] Project vocabulary read failed, using the global dictionary alone");
    return [];
  }
}

/** A pane in a Shell's view of one of this host's projects, as the Shell names it. */
export interface PaneScope {
  projectId: string;
  terminalId: string | null;
}

export interface PaneProjectInfo {
  name: string | null;
  path: string | null;
}

/** What a dictation starting in a host's pane needs from the host. */
export interface PaneStartContext {
  /** The name of the project owning the terminal, for its keyterm tier. */
  projectName: string | null;
  vocabulary: VoiceDictionaryEntry[];
  /** Screened as the keyterms screen them. */
  names: DictationNames;
  keyterms: PaneKeytermReads;
  commandTarget: VoiceCommandTarget | null;
}

/** What cleaning up a dictation in a host's pane needs from the host. */
export interface PaneCorrectionContext {
  /** The asking view's project. */
  project: PaneProjectInfo;
  vocabulary: VoiceDictionaryEntry[];
  commandTarget: VoiceCommandTarget | null;
  /** Bounded and redacted as for a local pane. */
  terminalOutput: string | null;
}

export const NO_PANE_START_CONTEXT: PaneStartContext = {
  projectName: null,
  vocabulary: [],
  names: NO_DICTATION_NAMES,
  keyterms: NO_PANE_KEYTERM_READS,
  commandTarget: null,
};

const NO_PROJECT: PaneProjectInfo = { name: null, path: null };

export interface HostPaneDeps {
  ptyClient: PtyClient | undefined;
  worktreeService: WorkspaceClient | undefined;
}

// A read still running at the deadline gives its fallback; the read itself
// isn't cancelled, and a failure it ends with later is still observed.
async function byDeadline<T>(read: Promise<T>, fallback: T, deadline: number): Promise<T> {
  const settled = read.catch(() => fallback);
  const remaining = Math.ceil(deadline - performance.now());
  if (remaining <= 0) return fallback;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), remaining);
      timer.unref();
    });
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function projectInfo(projectId: string): PaneProjectInfo {
  const { name, path } = getProjectInfo(projectId);
  return { name: name ?? null, path: path ?? null };
}

// A Shell asks only about its view's own project, and this host reads a
// terminal for it only when it files that terminal under that project: one
// another project owns is refused by the same rules as a local pane, and one
// filed under none is read as no terminal at all.
function hostTerminalId(scope: PaneScope, ptyClient: PtyClient | undefined): string | undefined {
  const { terminalId } = scope;
  if (!terminalId) return undefined;
  if (ptyClient?.hasTerminal(terminalId) && !ptyClient.getTerminalProjectId(terminalId)) {
    return undefined;
  }
  return terminalId;
}

/**
 * The start context of a host's pane, read here for a Shell with the same
 * reads and screens as a local pane's, within `budgetMs`.
 */
export async function answerPaneStart(
  deps: HostPaneDeps,
  scope: PaneScope,
  budgetMs: number
): Promise<PaneStartContext> {
  const { ptyClient, worktreeService } = deps;
  if (!projectStore.getProjectById(scope.projectId)) return NO_PANE_START_CONTEXT;
  const deadline = performance.now() + budgetMs;
  const terminalId = hostTerminalId(scope, ptyClient);
  const target = resolveKeytermTarget(scope.projectId, terminalId, ptyClient);
  const [vocabulary, names, keyterms, commandTarget] = await Promise.all([
    byDeadline(
      readVocabulary(resolveVocabularyProject(scope.projectId, terminalId, ptyClient)),
      [],
      deadline
    ),
    byDeadline(
      gatherDictationNames({
        projectId: scope.projectId,
        terminalId,
        ptyClient,
        worktreeService,
      }).then(screenDictationNames),
      NO_DICTATION_NAMES,
      deadline
    ),
    // Bounds each of its reads itself, so a slow one costs only its own.
    readPaneKeytermReads(
      { projectPath: target.projectPath, terminalId: target.terminalId, ptyClient },
      budgetMs
    ),
    resolveVoiceCommandTarget(ptyClient, target.terminalId, budgetMs),
  ]);
  return { projectName: target.projectName ?? null, vocabulary, names, keyterms, commandTarget };
}

/** The cleanup context of a host's pane, read here for a Shell within `budgetMs`. */
export async function answerPaneCorrection(
  deps: HostPaneDeps,
  scope: PaneScope,
  budgetMs: number
): Promise<PaneCorrectionContext> {
  const { ptyClient } = deps;
  if (!projectStore.getProjectById(scope.projectId)) {
    return { project: NO_PROJECT, vocabulary: [], commandTarget: null, terminalOutput: null };
  }
  const deadline = performance.now() + budgetMs;
  const terminalId = hostTerminalId(scope, ptyClient);
  const target = resolveKeytermTarget(scope.projectId, terminalId, ptyClient);
  const [vocabulary, commandTarget, terminalOutput] = await Promise.all([
    byDeadline(
      readVocabulary(resolveVocabularyProject(scope.projectId, terminalId, ptyClient)),
      [],
      deadline
    ),
    resolveVoiceCommandTarget(ptyClient, target.terminalId, budgetMs),
    readTerminalOutputForCorrection(
      ptyClient,
      target.terminalId,
      Math.min(TERMINAL_READ_BUDGET_MS, budgetMs)
    ),
  ]);
  return { project: projectInfo(scope.projectId), vocabulary, commandTarget, terminalOutput };
}

/**
 * The files this host's search offers for each description, in the folder a
 * local pane's references would resolve in, within `budgetMs`. Choosing among
 * them is the Shell's.
 */
export async function answerPaneFileCandidates(
  deps: HostPaneDeps,
  scope: PaneScope,
  descriptions: readonly string[],
  budgetMs: number
): Promise<string[][]> {
  const none = descriptions.map((): string[] => []);
  if (!projectStore.getProjectById(scope.projectId)) return none;
  const deadline = performance.now() + budgetMs;
  const cwd = await byDeadline(
    resolveFileLinkCwd(
      scope.projectId,
      hostTerminalId(scope, deps.ptyClient),
      projectInfo(scope.projectId).path,
      deps.ptyClient
    ),
    null,
    deadline
  );
  if (!cwd) return none;
  return Promise.all(
    descriptions.map((description) =>
      byDeadline(
        fileSearchService.searchNaturalLanguage({
          cwd,
          description,
          limit: FILE_LINK_CANDIDATE_LIMIT,
        }),
        [],
        deadline
      )
    )
  );
}

/** The name and folder of one of this host's projects, for a Shell's view of it. */
export function answerPaneProject(projectId: string): PaneProjectInfo {
  return projectInfo(projectId);
}
