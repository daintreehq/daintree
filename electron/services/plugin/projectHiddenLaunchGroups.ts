import { store } from "../../store.js";

/**
 * Each project's hidden launcher groups (#13788): the plugin instance ids whose
 * launch entries the project's launcher leaves out.
 *
 * Daintree's own settings, never the repository, so a project plugin cannot
 * pre-hide anyone else's group. An id whose plugin has since gone is kept
 * rather than pruned, as `projectFileEditorChoices.ts` keeps its answers: the
 * group stays hidden if the plugin comes back, and Project settings → Plugins
 * still lists it with a reset.
 *
 * No in-memory copy: reads happen on a view's first launcher and writes on a
 * click.
 */
const STORE_KEY = "projectHiddenLaunchGroups";

/** Most groups one project may hide; the file is user-editable, so it is bounded on read too. */
const MAX_HIDDEN_GROUPS = 200;

/** Longest plugin id a hidden group may name, on read and on write alike. */
export const MAX_HIDDEN_GROUP_ID_LENGTH = 300;

/** Whether `id` can name a hidden group: what is read back must be something a reset can send. */
export function isHiddenGroupId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_HIDDEN_GROUP_ID_LENGTH;
}

/** The file is user-editable, so anything that isn't a well-formed id is skipped. */
function parseHidden(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (isHiddenGroupId(id)) ids.add(id);
    if (ids.size >= MAX_HIDDEN_GROUPS) break;
  }
  return [...ids];
}

function readAll(): Record<string, unknown> {
  const stored = store.get(STORE_KEY) as unknown;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

export function getProjectHiddenLaunchGroups(projectId: string): string[] {
  return parseHidden(readAll()[projectId]);
}

/**
 * Hide or show one plugin's launcher group in `projectId`. Returns the
 * project's hidden ids. Throws rather than quietly keeping a group visible
 * when the project already hides as many as it may.
 */
export function setProjectLaunchGroupHidden(
  projectId: string,
  pluginId: string,
  hidden: boolean
): string[] {
  const all = readAll();
  const current = parseHidden(all[projectId]);
  if (current.includes(pluginId) === hidden) return current;
  if (hidden && current.length >= MAX_HIDDEN_GROUPS) {
    throw new Error(`launch group: this project already hides ${MAX_HIDDEN_GROUPS} groups`);
  }
  const next = hidden ? [...current, pluginId] : current.filter((id) => id !== pluginId);
  const updated = { ...all };
  if (next.length === 0) delete updated[projectId];
  else updated[projectId] = next;
  store.set(STORE_KEY, updated);
  return next;
}
