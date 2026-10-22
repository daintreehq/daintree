import { store } from "../../store.js";
import { isProjectWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import {
  PROJECT_SURFACE_SLOT_CATALOGUE,
  isProjectSurfaceChoice,
  isProjectSurfaceSlot,
  pluginManifestIdFromInstanceKey,
  type ProjectSurfaceChoice,
  type ProjectSurfaceChoiceRecord,
  type ProjectSurfaceChoices,
  type ProjectSurfaceSlot,
  type ProjectSurfaceSlotMode,
  type ProjectSurfaceSlotState,
} from "../../../shared/types/plugin.js";
import { getProjectSurfaceSlots } from "./PluginSurfaceRegistry.js";

/**
 * Each project's remembered answer about its plugin slots (§7.8): whether an
 * exclusive slot shows the plugin's surface or the host's stock content, and
 * which option a selectable slot shows.
 *
 * A slot claim replaces something the host draws, so the user's answer to it
 * outlives the session — a project whose owner chose the launcher should not
 * swap back on every relaunch. It is never silent, though: the renderer
 * discloses the answer in project plugin settings, with a reset.
 *
 * No in-memory copy. Reads happen on a view's first mount and writes on a
 * click, so a cache would buy nothing and add a second source of truth to keep
 * in step with the file.
 */
const STORE_KEY = "projectSurfaceChoices";

/**
 * One stored answer, or `undefined` when it is malformed for a slot of `mode`.
 *
 * An exclusive answer must name the plugin it was about. A selectable answer
 * names the picked option, or nothing when the user picked stock.
 */
export function parseProjectSurfaceChoiceRecord(
  value: unknown,
  mode: ProjectSurfaceSlotMode
): ProjectSurfaceChoiceRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { pluginId, choice, decidedAt, optionId } = value as Record<string, unknown>;
  if (typeof pluginId !== "string") return undefined;
  if (!isProjectSurfaceChoice(choice)) return undefined;
  const at = typeof decidedAt === "number" ? decidedAt : 0;
  if (mode === "exclusive") {
    if (pluginId.length === 0) return undefined;
    return { pluginId, choice, decidedAt: at };
  }
  if (choice === "stock") return { pluginId: "", choice, decidedAt: at };
  if (typeof optionId !== "string" || optionId.length === 0 || pluginId.length === 0) {
    return undefined;
  }
  return { pluginId, choice, decidedAt: at, optionId };
}

/** The file is user-editable, so every level is checked and anything malformed is skipped. */
function parseChoices(value: unknown): ProjectSurfaceChoices {
  const choices: ProjectSurfaceChoices = {};
  if (!value || typeof value !== "object") return choices;
  for (const [slot, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isProjectSurfaceSlot(slot)) continue;
    const record = parseProjectSurfaceChoiceRecord(raw, PROJECT_SURFACE_SLOT_CATALOGUE[slot].mode);
    if (record !== undefined) choices[slot] = record;
  }
  return choices;
}

/**
 * The record to store for an answer about `slot`, resolved against the slot's
 * arbitrated `state` rather than taken from the caller: a renderer can only
 * answer about a plugin actually on offer, never pre-answer for one that has
 * not claimed the slot.
 *
 * Throws when the answer names nothing on offer.
 */
export function buildProjectSurfaceChoiceRecord(
  mode: ProjectSurfaceSlotMode,
  slot: ProjectSurfaceSlot,
  state: ProjectSurfaceSlotState | undefined,
  choice: ProjectSurfaceChoice,
  optionId: string | undefined,
  now: number
): ProjectSurfaceChoiceRecord {
  if (mode === "exclusive") {
    if (optionId !== undefined) {
      throw new Error(`project surfaces: ${slot} has one option, so an answer names none`);
    }
    const owner = state?.defaultOptionId ?? null;
    if (owner === null) {
      throw new Error(`project surfaces: no plugin claims ${slot} in this project`);
    }
    return { pluginId: pluginManifestIdFromInstanceKey(owner), choice, decidedAt: now };
  }
  if (choice === "stock") return { pluginId: "", choice, decidedAt: now };
  const option = state?.options.find((entry) => entry.pluginId === optionId);
  if (optionId === undefined || option === undefined) {
    throw new Error(`project surfaces: ${slot} offers no such option in this project`);
  }
  return {
    pluginId: pluginManifestIdFromInstanceKey(option.pluginId),
    choice,
    decidedAt: now,
    optionId,
  };
}

function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

/**
 * Every stored answer for one project.
 *
 * Throws when the store cannot be read. An unreadable answer is not the same as
 * no answer: read as empty, it would put a canvas the user switched off back on
 * screen and ask them again, where a rejected read keeps the renderer on the
 * stock canvas until a later read works.
 */
export function getProjectSurfaceChoices(projectId: string): ProjectSurfaceChoices {
  const all = readAll();
  return Object.hasOwn(all, projectId) ? parseChoices(all[projectId]) : {};
}

/**
 * Remember this project's answer about `slot`, or forget it with `null`.
 *
 * The answer is resolved against main's own claim registry (see
 * {@link buildProjectSurfaceChoiceRecord}): an exclusive answer names whichever
 * plugin owns the slot NOW, and a selectable one must name an option on offer.
 *
 * Throws when a non-null answer has nothing on offer to be about, and when the
 * store cannot be read or written — the caller reports success and rebroadcasts
 * on the strength of this returning. Returns the project's full set after the
 * write.
 */
export function setProjectSurfaceChoice(
  projectId: string,
  slot: ProjectSurfaceSlot,
  choice: ProjectSurfaceChoice | null,
  optionId?: string,
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
  if (optionId !== undefined && (typeof optionId !== "string" || optionId.length === 0)) {
    throw new Error("project surfaces: optionId must be a non-empty string");
  }

  const record =
    choice === null
      ? undefined
      : buildProjectSurfaceChoiceRecord(
          PROJECT_SURFACE_SLOT_CATALOGUE[slot].mode,
          slot,
          getProjectSurfaceSlots(projectId)[slot],
          choice,
          optionId,
          now
        );

  // A read failure propagates rather than falling back to empty: this rewrites
  // the whole key, so writing from a map we could not read would delete every
  // other project's answers.
  const all = { ...readAll() };
  const stored = Object.hasOwn(all, projectId) ? all[projectId] : undefined;
  // Merged into the raw entry, not a parsed copy, so an answer about a slot this
  // build does not know — written by a newer one — survives a downgrade.
  const entry: Record<string, unknown> =
    stored && typeof stored === "object" && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
  if (record === undefined) {
    delete entry[slot];
  } else {
    entry[slot] = record;
  }
  if (Object.keys(entry).length === 0) {
    delete all[projectId];
  } else {
    all[projectId] = entry;
  }
  // Whole-key rewrite: electron-store dot-notation would nest on a key
  // containing dots, and a project id is opaque.
  store.set(STORE_KEY, all);
  return parseChoices(entry);
}
