import { store } from "../../store.js";
import { isSafePluginInstanceId } from "./projectPluginIdentity.js";

/**
 * The plugins whose notifications the user silenced (#13818), by instance id.
 *
 * An instance id is the manifest id for an installed plugin and
 * `project__{projectId}__{manifestId}` for a project plugin, so one list holds
 * both scopes: an installed plugin is silenced everywhere, a project plugin in
 * its own project only. Neither id changes across an update or a reinstall, so
 * the silence outlives both, the way the hidden launcher groups do.
 *
 * Daintree's own settings, never the repository: a plugin must not be able to
 * ship itself pre-silenced against a rival, or unsilenced against the user.
 * No in-memory copy: every toast and notification reads it fresh, so a change
 * from any window holds from the next call.
 */
const STORE_KEY = "pluginNotificationSilences";

/** Most plugins one machine may silence; the file is user-editable, so it is bounded on read too. */
const MAX_SILENCES = 500;

/** The file is user-editable, so anything that isn't a well-formed instance id is skipped. */
function parseSilences(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && isSafePluginInstanceId(id)) ids.add(id);
    if (ids.size >= MAX_SILENCES) break;
  }
  return [...ids];
}

export function getPluginNotificationSilences(): string[] {
  return parseSilences(store.get(STORE_KEY) as unknown);
}

export function isPluginNotificationSilenced(pluginId: string): boolean {
  return getPluginNotificationSilences().includes(pluginId);
}

/**
 * Silence or unsilence one plugin instance and return the silenced ids. Throws
 * rather than quietly leaving a plugin audible once the list is full.
 */
export function setPluginNotificationSilenced(pluginId: string, silenced: boolean): string[] {
  const current = getPluginNotificationSilences();
  if (current.includes(pluginId) === silenced) return current;
  if (silenced && current.length >= MAX_SILENCES) {
    throw new Error(`plugin notifications: already ${MAX_SILENCES} plugins silenced`);
  }
  const next = silenced ? [...current, pluginId] : current.filter((id) => id !== pluginId);
  store.set(STORE_KEY, next);
  return next;
}
