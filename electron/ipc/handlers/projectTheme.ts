import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { PROJECT_THEME_METHOD_CHANNELS } from "./projectTheme.preload.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  answerProjectThemeSuggestion,
  getProjectThemeChoice,
  publishProjectThemeChoice,
  resetProjectThemeSuggestion,
  setProjectThemeScheme,
} from "../../services/projectThemeStore.js";
import { parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import type { ProjectThemeSuggestionAnswer } from "../../../shared/theme/types.js";
import type { ProjectThemeSnapshot } from "../../../shared/types/ipc/projectTheme.js";

/**
 * The SENDER project's own theme (#13833). No op takes a project id: main
 * resolves it from the sender's own view registration, so a view can only
 * ever read or change the theme of the project it shows.
 */

async function readSuggestedSchemeId(projectId: string): Promise<string | null> {
  const project = projectStore.getProjectById(projectId);
  if (!project) return null;
  try {
    return (await projectStore.readInRepoProjectIdentity(project.path)).theme ?? null;
  } catch {
    return null;
  }
}

async function snapshotOf(projectId: string): Promise<ProjectThemeSnapshot> {
  const suggestedSchemeId = await readSuggestedSchemeId(projectId);
  // Read after the await, so a reply never carries an older choice than a push sent meanwhile.
  return { projectId, choice: getProjectThemeChoice(projectId), suggestedSchemeId };
}

/** The key the renderer and the boot paths use: a remote view knows the bare project id. */
function senderProjectId(ctx: IpcContext): string | null {
  return ctx.projectId ? parseHostScopedKey(ctx.projectId).projectId : null;
}

function requireProjectId(ctx: IpcContext): string {
  const projectId = senderProjectId(ctx);
  if (!projectId) throw new Error("project theme: sender has no project");
  return projectId;
}

/** `null` for a sender with no project binding yet, rather than a project with no theme. */
async function handleGet(ctx: IpcContext): Promise<ProjectThemeSnapshot | null> {
  const projectId = senderProjectId(ctx);
  return projectId ? snapshotOf(projectId) : null;
}

async function handleSetTheme(
  ctx: IpcContext,
  schemeId: string | null
): Promise<ProjectThemeSnapshot> {
  const projectId = requireProjectId(ctx);
  if (schemeId !== null && typeof schemeId !== "string") {
    throw new Error("project theme: schemeId must be a string or null");
  }
  setProjectThemeScheme(projectId, schemeId);
  publishProjectThemeChoice(projectId);
  return snapshotOf(projectId);
}

async function handleAnswerSuggestion(
  ctx: IpcContext,
  schemeId: string,
  answer: ProjectThemeSuggestionAnswer
): Promise<ProjectThemeSnapshot> {
  const projectId = requireProjectId(ctx);
  if (typeof schemeId !== "string" || !schemeId) {
    throw new Error("project theme: schemeId is required");
  }
  if (answer !== "accepted" && answer !== "declined") {
    throw new Error("project theme: answer must be accepted or declined");
  }
  // Re-read rather than trust the renderer: the answer only counts for what
  // the file suggests NOW, and only if that is what the notice showed.
  if ((await readSuggestedSchemeId(projectId)) !== schemeId) {
    throw new Error("project theme: the repository no longer suggests this theme");
  }
  answerProjectThemeSuggestion(projectId, schemeId, answer);
  publishProjectThemeChoice(projectId);
  return snapshotOf(projectId);
}

async function handleResetSuggestion(ctx: IpcContext): Promise<ProjectThemeSnapshot> {
  const projectId = requireProjectId(ctx);
  resetProjectThemeSuggestion(projectId);
  publishProjectThemeChoice(projectId);
  return snapshotOf(projectId);
}

export const projectThemeNamespace = defineIpcNamespace({
  name: "projectTheme",
  ops: {
    get: op(PROJECT_THEME_METHOD_CHANNELS.get, handleGet, { withContext: true }),
    setTheme: op(PROJECT_THEME_METHOD_CHANNELS.setTheme, handleSetTheme, { withContext: true }),
    answerSuggestion: op(PROJECT_THEME_METHOD_CHANNELS.answerSuggestion, handleAnswerSuggestion, {
      withContext: true,
    }),
    resetSuggestion: op(PROJECT_THEME_METHOD_CHANNELS.resetSuggestion, handleResetSuggestion, {
      withContext: true,
    }),
  },
});

export function registerProjectThemeHandlers(): () => void {
  return projectThemeNamespace.register();
}
