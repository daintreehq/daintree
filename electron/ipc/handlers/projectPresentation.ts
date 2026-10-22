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
  isOwnProjectPluginButtonId,
  resetProjectToolbar,
  setProjectFeaturedLaunchEntry,
  setProjectLauncherGroupOrder,
  setProjectPluginButtonPromoted,
  setProjectPresentationLevel,
  setProjectToolbarEnabled,
} from "../../services/projectPresentation/profileStore.js";
import { getAllPluginLaunchEntries } from "../../../shared/config/pluginLaunchEntryRegistry.js";
import {
  featuredRefForLaunchEntry,
  isFeaturedLaunchEntryRef,
} from "../../../shared/config/launcherArrangement.js";
import { getToolbarButtonConfig } from "../../../shared/config/toolbarButtonRegistry.js";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";
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
 * at once each publish what is on disk at that moment, so a later push never
 * carries an older profile than the one before it. The revision covers what
 * this cannot — a push and a reply reaching a view out of order.
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
    useProjectToolbar: stored.useProjectToolbar,
    promotedPluginButtons: stored.promotedPluginButtons,
    launcherGroupOrder: stored.launcherGroupOrder,
    featuredLaunchEntry: stored.featuredLaunchEntry,
    revision: stored.revision,
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

async function handleSetToolbarEnabled(
  ctx: IpcContext,
  enabled: boolean
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  if (typeof enabled !== "boolean") {
    throw new Error("project presentation: enabled must be a boolean");
  }
  setProjectToolbarEnabled(projectId, enabled);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
}

/**
 * Promotion is checked against the live registry as well as the id's shape:
 * the button has to be registered right now by a plugin loaded for the
 * sender's own project. An installed plugin never gets a say over placement
 * (#11304), and taking a promotion back needs neither, so a button whose
 * plugin has since gone can still be let go.
 */
async function handleSetPluginButtonPromoted(
  ctx: IpcContext,
  buttonId: string,
  promoted: boolean
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  if (typeof buttonId !== "string" || buttonId.length === 0) {
    throw new Error("project presentation: buttonId is required");
  }
  if (typeof promoted !== "boolean") {
    throw new Error("project presentation: promoted must be a boolean");
  }
  if (promoted) {
    const config = getToolbarButtonConfig(buttonId);
    if (
      config === undefined ||
      projectIdFromPluginInstanceKey(config.pluginId) !== projectId ||
      !isOwnProjectPluginButtonId(projectId, buttonId)
    ) {
      throw new Error(
        "project presentation: only this project's own plugin buttons can be promoted"
      );
    }
  }
  setProjectPluginButtonPromoted(projectId, buttonId, promoted);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
}

async function handleResetToolbar(ctx: IpcContext): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  resetProjectToolbar(projectId);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
}

async function handleSetLauncherGroupOrder(
  ctx: IpcContext,
  order: string[]
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  setProjectLauncherGroupOrder(projectId, order);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
}

/**
 * Featuring is checked against the live registry: the entry has to be
 * registered right now by a plugin loaded for the sender's own project, so an
 * installed plugin's entry is never featured from here. Clearing needs
 * neither, so an entry whose plugin has gone can still be let go.
 */
async function handleSetFeaturedLaunchEntry(
  ctx: IpcContext,
  ref: string | null
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  if (ref !== null) {
    if (
      !isFeaturedLaunchEntryRef(ref) ||
      !getAllPluginLaunchEntries().some(
        (entry) => featuredRefForLaunchEntry(entry, projectId) === ref
      )
    ) {
      throw new Error(
        "project presentation: only this project's own plugin entries can be featured"
      );
    }
  }
  setProjectFeaturedLaunchEntry(projectId, ref);
  return publish(snapshotOf(projectId, await readSuggestion(projectId)));
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
    setToolbarEnabled: op(
      PROJECT_PRESENTATION_METHOD_CHANNELS.setToolbarEnabled,
      handleSetToolbarEnabled,
      { withContext: true }
    ),
    setPluginButtonPromoted: op(
      PROJECT_PRESENTATION_METHOD_CHANNELS.setPluginButtonPromoted,
      handleSetPluginButtonPromoted,
      { withContext: true }
    ),
    resetToolbar: op(PROJECT_PRESENTATION_METHOD_CHANNELS.resetToolbar, handleResetToolbar, {
      withContext: true,
    }),
    setLauncherGroupOrder: op(
      PROJECT_PRESENTATION_METHOD_CHANNELS.setLauncherGroupOrder,
      handleSetLauncherGroupOrder,
      { withContext: true }
    ),
    setFeaturedLaunchEntry: op(
      PROJECT_PRESENTATION_METHOD_CHANNELS.setFeaturedLaunchEntry,
      handleSetFeaturedLaunchEntry,
      { withContext: true }
    ),
  },
});

export function registerProjectPresentationHandlers(): () => void {
  return projectPresentationNamespace.register();
}
