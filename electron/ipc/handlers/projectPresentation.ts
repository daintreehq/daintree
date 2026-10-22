import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import type { IpcContext } from "../types.js";
import { broadcastToProjectRenderers } from "../utils.js";
import { PROJECT_PRESENTATION_METHOD_CHANNELS } from "./projectPresentation.preload.js";
import { projectStore } from "../../services/ProjectStore.js";
import {
  answerFor,
  answerProjectPresentationSuggestion,
  getProjectPresentation,
  setProjectPresentationLevel,
} from "../../services/projectPresentation/profileStore.js";
import { readPresentationSuggestion } from "../../services/projectPresentation/repoSuggestion.js";
import {
  isLevelAllowed,
  isPresentationFeatureId,
  type PresentationFeatureId,
  type PresentationLevel,
} from "../../../shared/config/presentationProfile.js";
import type {
  PresentationSuggestion,
  PresentationSuggestionAnswer,
  ProjectPresentationSnapshot,
} from "../../../shared/types/ipc/projectPresentation.js";

/**
 * The SENDER project's presentation profile (#13771). No op takes a project
 * id: main resolves it from the sender's own view registration, so a view can
 * only ever read or change the profile of the project it shows.
 */

function readSuggestion(projectId: string): Promise<PresentationSuggestion | null> {
  return readPresentationSuggestion(projectStore.getProjectById(projectId)?.path);
}

/**
 * Built from the store as it stands NOW, after any await: two windows writing
 * at once each publish what is on disk at that moment, so the later push can
 * never carry an older profile than the one before it.
 */
function snapshotOf(
  projectId: string,
  suggestion: PresentationSuggestion | null
): ProjectPresentationSnapshot {
  const stored = getProjectPresentation(projectId);
  return {
    projectId,
    levels: stored.levels,
    suggestion,
    suggestionAnswer: answerFor(stored, suggestion),
  };
}

/** Every view of the project — the notice and the settings section can sit in different windows. */
function publish(snapshot: ProjectPresentationSnapshot): ProjectPresentationSnapshot {
  broadcastToProjectRenderers(snapshot.projectId, CHANNELS.PROJECT_PRESENTATION_CHANGED, snapshot);
  return snapshot;
}

function requireProjectId(ctx: IpcContext): string {
  if (!ctx.projectId) throw new Error("project presentation: sender has no project");
  return ctx.projectId;
}

/**
 * `null`, not an empty profile, for a sender with no project binding yet: a
 * relaunch restores the last project before its view is registered, and "no
 * profile" in that window would ask the suggestion question of a project that
 * answered it long ago.
 */
async function handleGet(ctx: IpcContext): Promise<ProjectPresentationSnapshot | null> {
  if (!ctx.projectId) return null;
  const projectId = ctx.projectId;
  return snapshotOf(projectId, await readSuggestion(projectId));
}

async function handleSetLevel(
  ctx: IpcContext,
  feature: PresentationFeatureId,
  level: PresentationLevel | null
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  if (!isPresentationFeatureId(feature)) {
    throw new Error("project presentation: unknown feature");
  }
  if (level !== null && !isLevelAllowed(feature, level)) {
    throw new Error("project presentation: unsupported level");
  }
  setProjectPresentationLevel(projectId, feature, level);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
}

async function handleAnswerSuggestion(
  ctx: IpcContext,
  hash: string,
  answer: PresentationSuggestionAnswer
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  if (typeof hash !== "string" || hash.length === 0) {
    throw new Error("project presentation: hash is required");
  }
  // Re-read rather than trust the renderer: accepting copies what the file
  // suggests NOW, and only if that is what the notice showed.
  const suggestion = await readSuggestion(projectId);
  answerProjectPresentationSuggestion(projectId, suggestion, hash, answer);
  return publish(snapshotOf(projectId, suggestion));
}

export const projectPresentationNamespace = defineIpcNamespace({
  name: "projectPresentation",
  ops: {
    get: op(PROJECT_PRESENTATION_METHOD_CHANNELS.get, handleGet, { withContext: true }),
    setLevel: op(PROJECT_PRESENTATION_METHOD_CHANNELS.setLevel, handleSetLevel, {
      withContext: true,
    }),
    answerSuggestion: op(
      PROJECT_PRESENTATION_METHOD_CHANNELS.answerSuggestion,
      handleAnswerSuggestion,
      { withContext: true }
    ),
  },
});

export function registerProjectPresentationHandlers(): () => void {
  return projectPresentationNamespace.register();
}
