import { store } from "../../store.js";
import { createLogger } from "../../utils/logger.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  isProjectSurfaceChoice,
  isProjectSurfaceSlot,
  pluginManifestIdFromInstanceKey,
  type ProjectSurfaceChoice,
  type ProjectSurfaceChoiceRecord,
  type ProjectSurfaceChoices,
  type ProjectSurfaceSlot,
} from "../../../shared/types/plugin.js";
import { getProjectSurfaces } from "./PluginSurfaceRegistry.js";

/**
 * Each project's remembered answer about its plugin surface claims (§7.8):
 * whether a claimed slot shows the plugin's surface or the host's stock content.
 *
 * A surface claim replaces something the host draws, so the user's answer to it
 * outlives the session — a project whose owner chose the launcher should not
 * swap back on every relaunch. It is never silent, though: the renderer
 * discloses the answer in project plugin settings, with a reset.
 *
 * No in-memory copy. Reads happen on a view's first mount and writes on a
 * click, so a cache would buy nothing and add a second source of truth to keep
 * in step with the file.
 */
const STORE_KEY = "projectSurfaceChoices";

const logger = createLogger("main:projectSurfaceChoices");

function parseRecord(value: unknown): ProjectSurfaceChoiceRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { pluginId, choice, decidedAt } = value as Record<string, unknown>;
  if (typeof pluginId !== "string" || pluginId.length === 0) return undefined;
  if (!isProjectSurfaceChoice(choice)) return undefined;
  return { pluginId, choice, decidedAt: typeof decidedAt === "number" ? decidedAt : 0 };
}

/** The file is user-editable, so every level is checked and anything malformed is skipped. */
function parseChoices(value: unknown): ProjectSurfaceChoices {
  const choices: ProjectSurfaceChoices = {};
  if (!value || typeof value !== "object") return choices;
  for (const [slot, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isProjectSurfaceSlot(slot)) continue;
    const record = parseRecord(raw);
    if (record !== undefined) choices[slot] = record;
  }
  return choices;
}

function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * Every stored answer for one project. An unreadable store reads as no answers,
 * which shows the plugin's surface — what the project's own manifest asked for —
 * and at worst asks the user again.
 */
export function getProjectSurfaceChoices(projectId: string): ProjectSurfaceChoices {
  try {
    const all = readAll();
    return Object.hasOwn(all, projectId) ? parseChoices(all[projectId]) : {};
  } catch (err) {
    logger.warn("Failed to read project surface choices", { projectId, error: err });
    return {};
  }
}

/**
 * Remember this project's answer about `slot`, or forget it with `null`.
 *
 * The answer names whichever plugin owns the slot NOW, resolved from main's own
 * claim registry rather than taken from the caller: a renderer can only answer
 * about the plugin actually drawing its canvas, never pre-answer for one that
 * has not claimed it yet.
 *
 * Throws when a non-null answer has no claim to be about, and when the store
 * cannot be read or written — the caller reports success and rebroadcasts on
 * the strength of this returning. Returns the project's full set after the
 * write.
 */
export function setProjectSurfaceChoice(
  projectId: string,
  slot: ProjectSurfaceSlot,
  choice: ProjectSurfaceChoice | null,
  now: number = Date.now()
): ProjectSurfaceChoices {
  if (!isProjectWorkspaceId(projectId)) {
    throw new Error("project surfaces: projectId must be a project workspace id");
  }
  if (!isProjectSurfaceSlot(slot)) {
    throw new Error("project surfaces: unknown surface slot");
  }
  if (choice !== null && !isProjectSurfaceChoice(choice)) {
    throw new Error('project surfaces: choice must be "surface", "stock" or null');
  }

  let record: ProjectSurfaceChoiceRecord | undefined;
  if (choice !== null) {
    const owner = getProjectSurfaces(projectId)[slot];
    if (owner === undefined) {
      throw new Error(`project surfaces: no plugin claims ${slot} in this project`);
    }
    record = { pluginId: pluginManifestIdFromInstanceKey(owner.pluginId), choice, decidedAt: now };
  }

  // A read failure propagates rather than falling back to empty: this rewrites
  // the whole key, so writing from a map we could not read would delete every
  // other project's answers.
  const all = { ...readAll() };
  const next = Object.hasOwn(all, projectId) ? parseChoices(all[projectId]) : {};
  if (record === undefined) {
    delete next[slot];
  } else {
    next[slot] = record;
  }
  if (Object.keys(next).length === 0) {
    delete all[projectId];
  } else {
    all[projectId] = next;
  }
  // Whole-key rewrite: electron-store dot-notation would nest on a key
  // containing dots, and a project id is opaque.
  store.set(STORE_KEY, all);
  return next;
}
