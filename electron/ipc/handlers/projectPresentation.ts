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
import { detectWebProject } from "../../services/projectPresentation/webProjectDetection.js";
import { events } from "../../services/events.js";
import { pathComparisonKey } from "../../../shared/utils/path.js";
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

/** What the project's own files say right now; read for every snapshot, never stored. */
interface RepoFacts {
  suggestion: PresentationSuggestion | null;
  webProject: boolean | null;
}

/**
 * Projects some view has read, by the root their web-project answer comes from
 * (#14069), with the answer last broadcast to every view of the project. A
 * read's reply reaches only the view that asked, so it never counts as told:
 * a change under the root compares against what all of them were last sent.
 */
const watched = new Map<string, { rootKey: string; broadcast: boolean | null }>();
// Bumped when the handlers go, so a read still in flight then records and publishes nothing.
let registration = 0;

/** One spelling per directory: git and the project list can disagree on NFC/NFD and case. */
function rootKeyOf(root: string): string {
  return pathComparisonKey(root, {
    caseInsensitive: process.platform === "win32" || process.platform === "darwin",
  });
}

async function readRepoFacts(projectId: string): Promise<RepoFacts> {
  const root = projectStore.getProjectById(projectId)?.path;
  const startedIn = registration;
  const [suggestion, webProject] = await Promise.all([
    readPresentationSuggestion(root),
    detectWebProject(root),
  ]);
  if (root && startedIn === registration) {
    const known = watched.get(projectId);
    // The first read seeds it: until something is broadcast, that is what every view has.
    watched.set(projectId, {
      rootKey: rootKeyOf(root),
      broadcast: known ? known.broadcast : webProject,
    });
  }
  return { suggestion, webProject };
}

/**
 * Built from the store as it stands NOW, after any await: two windows writing
 * at once each publish what is on disk at that moment, so a later push never
 * carries an older profile than the one before it. The revision covers what
 * this cannot — a push and a reply reaching a view out of order.
 */
function snapshotOf(projectId: string, facts: RepoFacts): ProjectPresentationSnapshot {
  const stored = getProjectPresentation(projectId);
  return {
    projectId,
    levels: stored.levels,
    suggestion: facts.suggestion,
    suggestionAnswer: answerFor(stored, facts.suggestion),
    useProjectToolbar: stored.useProjectToolbar,
    promotedPluginButtons: stored.promotedPluginButtons,
    launcherGroupOrder: stored.launcherGroupOrder,
    featuredLaunchEntry: stored.featuredLaunchEntry,
    webProject: facts.webProject,
    revision: stored.revision,
  };
}

/** Every view of the project — the notice and the settings section can sit in different windows. */
function publish(snapshot: ProjectPresentationSnapshot): ProjectPresentationSnapshot {
  broadcastToProjectRenderers(snapshot.projectId, CHANNELS.PROJECT_PRESENTATION_CHANGED, snapshot);
  const known = watched.get(snapshot.projectId);
  if (known) known.broadcast = snapshot.webProject;
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
  return snapshotOf(projectId, await readRepoFacts(projectId));
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
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
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
  const facts = await readRepoFacts(projectId);
  answerProjectPresentationSuggestion(projectId, facts.suggestion, hash, answer);
  return publish(snapshotOf(projectId, facts));
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
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
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
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
}

async function handleResetToolbar(ctx: IpcContext): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  resetProjectToolbar(projectId);
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
}

async function handleSetLauncherGroupOrder(
  ctx: IpcContext,
  order: string[]
): Promise<ProjectPresentationSnapshot> {
  const projectId = requireProjectId(ctx);
  setProjectLauncherGroupOrder(projectId, order);
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
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
  return publish(snapshotOf(projectId, await readRepoFacts(projectId)));
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

const redetecting = new Set<string>();
const redetectAgain = new Set<string>();

/**
 * Read a project's files again after something under its root changed, and
 * tell its views only if that changed whether it looks like a web project: a
 * folder added before it was scaffolded becomes one later (#13152's shape).
 * One read per project at a time; a change landing mid-read reads once more.
 */
async function redetect(projectId: string): Promise<void> {
  if (redetecting.has(projectId)) {
    redetectAgain.add(projectId);
    return;
  }
  const mine = registration;
  redetecting.add(projectId);
  try {
    do {
      redetectAgain.delete(projectId);
      const facts = await readRepoFacts(projectId);
      if (mine !== registration) return;
      if (facts.webProject !== watched.get(projectId)?.broadcast) {
        publish(snapshotOf(projectId, facts));
      }
    } while (redetectAgain.has(projectId));
  } catch (err) {
    console.warn("[ProjectPresentation] Couldn't re-read the project's files:", err);
  } finally {
    redetecting.delete(projectId);
  }
}

/**
 * Worktree updates are how main hears that files changed in a repository, and
 * they already arrive debounced. Only a project's own root counts: that is
 * the folder its web-project answer is read from.
 */
function watchProjectRoots(): () => void {
  return events.on("sys:worktree:update", (worktree) => {
    if (typeof worktree?.path !== "string" || worktree.path.length === 0) return;
    const changed = rootKeyOf(worktree.path);
    for (const [projectId, { rootKey }] of watched) {
      if (rootKey === changed) void redetect(projectId);
    }
  });
}

export function registerProjectPresentationHandlers(): () => void {
  const unregister = projectPresentationNamespace.register();
  const stopWatching = watchProjectRoots();
  return () => {
    registration++;
    stopWatching();
    watched.clear();
    redetecting.clear();
    redetectAgain.clear();
    unregister();
  };
}
