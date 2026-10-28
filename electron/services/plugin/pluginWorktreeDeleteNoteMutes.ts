// eager-import-allow: reads delete-note mutes via store.get synchronously before selecting plugins for a worktree deletion confirmation
import { store } from "../../store.js";
import { isSafePluginInstanceId } from "./projectPluginIdentity.js";

/**
 * The plugins whose worktree delete notes the user turned off (#13805), by
 * instance id: an installed plugin is muted everywhere, a project plugin in
 * its own project only. A muted plugin is not activated or asked when a delete
 * is confirmed.
 *
 * Daintree's own settings, never the repository, so a plugin can't ship itself
 * unmuted. No in-memory copy: every confirmation reads it fresh, so a change
 * from any window holds from the next one.
 */
const STORE_KEY = "pluginWorktreeDeleteNoteMutes";

/** Most plugins one machine may mute; the file is user-editable, so it is bounded on read too. */
const MAX_MUTES = 500;

function parseMutes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const id of value) {
    if (typeof id === "string" && isSafePluginInstanceId(id)) ids.add(id);
    if (ids.size >= MAX_MUTES) break;
  }
  return [...ids];
}

export function getWorktreeDeleteNoteMutes(): string[] {
  return parseMutes(store.get(STORE_KEY) as unknown);
}

export function isWorktreeDeleteNotesMuted(pluginId: string): boolean {
  return getWorktreeDeleteNoteMutes().includes(pluginId);
}

/**
 * Turn one plugin instance's notes on or off and return whether they are on.
 * Throws rather than quietly leaving a plugin on once the list is full.
 */
export function setWorktreeDeleteNotesEnabled(pluginId: string, enabled: boolean): boolean {
  const current = getWorktreeDeleteNoteMutes();
  const muted = current.includes(pluginId);
  if (muted !== enabled) return enabled;
  if (!enabled && current.length >= MAX_MUTES) {
    throw new Error(`worktree delete notes: already ${MAX_MUTES} plugins muted`);
  }
  store.set(STORE_KEY, enabled ? current.filter((id) => id !== pluginId) : [...current, pluginId]);
  return !isWorktreeDeleteNotesMuted(pluginId);
}
