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
import { isLocalHostId, parseHostScopedKey } from "../../../shared/types/remoteHosts.js";
import type { ProjectThemeSuggestionAnswer } from "../../../shared/theme/types.js";
import type { ProjectThemeSnapshot } from "../../../shared/types/ipc/projectTheme.js";

/**
 * The SENDER project's own theme (#13833). No op takes a project id: main
 * resolves it from the sender's own view registration, so a view can only
 * ever read or change the theme of the project it shows.
 */

interface Sender {
  /** The bare project id the choice is stored under, as the view's renderer knows it. */
  projectId: string;
  local: boolean;
}

/**
 * Only a local project's repository is on this machine to read. A remote
 * project's suggestion would have to come from its host, so it is not offered.
 */
async function readSuggestedSchemeId(sender: Sender): Promise<string | null> {
  if (!sender.local) return null;
  const project = projectStore.getProjectById(sender.projectId);
  if (!project) return null;
  try {
    return (await projectStore.readInRepoProjectIdentity(project.path)).theme ?? null;
  } catch {
    return null;
  }
}

async function snapshotOf(sender: Sender): Promise<ProjectThemeSnapshot> {
  const suggestedSchemeId = await readSuggestedSchemeId(sender);
  // Read after the await, so a reply never carries an older choice than a push sent meanwhile.
  const { projectId } = sender;
  return { projectId, choice: getProjectThemeChoice(projectId), suggestedSchemeId };
}

/**
 * The choice is stored under the bare project id, which is what the boot paths
 * and the view's renderer know it by, for a remote view as for a local one.
 */
function senderOf(ctx: IpcContext): Sender | null {
  if (!ctx.projectId) return null;
  const { hostId, projectId } = parseHostScopedKey(ctx.projectId);
  return { projectId, local: isLocalHostId(hostId) };
}

function requireSender(ctx: IpcContext): Sender {
  const sender = senderOf(ctx);
  if (!sender) throw new Error("project theme: sender has no project");
  return sender;
}


/** `null` for a sender with no project binding yet, rather than a project with no theme. */
async function handleGet(ctx: IpcContext): Promise<ProjectThemeSnapshot | null> {
  const sender = senderOf(ctx);
  return sender ? snapshotOf(sender) : null;
}

async function handleSetTheme(
  ctx: IpcContext,
  schemeId: string | null
): Promise<ProjectThemeSnapshot> {
  const sender = requireSender(ctx);
  if (schemeId !== null && typeof schemeId !== "string") {
    throw new Error("project theme: schemeId must be a string or null");
  }
  setProjectThemeScheme(sender.projectId, schemeId);
  publishProjectThemeChoice(sender.projectId);
  return snapshotOf(sender);
}

async function handleAnswerSuggestion(
  ctx: IpcContext,
  schemeId: string,
  answer: ProjectThemeSuggestionAnswer
): Promise<ProjectThemeSnapshot> {
  const sender = requireSender(ctx);
  if (typeof schemeId !== "string" || !schemeId) {
    throw new Error("project theme: schemeId is required");
  }
  if (answer !== "accepted" && answer !== "declined") {
    throw new Error("project theme: answer must be accepted or declined");
  }
  // Re-read rather than trust the renderer: the answer only counts for what
  // the file suggests NOW, and only if that is what the notice showed.
  if ((await readSuggestedSchemeId(sender)) !== schemeId) {
    throw new Error("project theme: the repository no longer suggests this theme");
  }
  answerProjectThemeSuggestion(sender.projectId, schemeId, answer);
  publishProjectThemeChoice(sender.projectId);
  return snapshotOf(sender);
}

async function handleResetSuggestion(ctx: IpcContext): Promise<ProjectThemeSnapshot> {
  const sender = requireSender(ctx);
  resetProjectThemeSuggestion(sender.projectId);
  publishProjectThemeChoice(sender.projectId);
  return snapshotOf(sender);
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
