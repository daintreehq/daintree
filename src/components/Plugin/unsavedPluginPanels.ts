import { logError } from "@/utils/logger";
import type { PluginUnsavedPanel } from "@shared/types/pluginUnsavedPanels";

/**
 * The open panels of a plugin, in any view, that say they hold unsaved work
 * (#15031), or `null` when main couldn't be asked. Main answers from what the
 * views last reported, so no plugin code is waited on.
 */
export async function readUnsavedPanels(pluginId: string): Promise<PluginUnsavedPanel[] | null> {
  try {
    return await window.electron.plugin.getUnsavedPanels(pluginId);
  } catch (err) {
    logError("Failed to read plugin panels with unsaved work", err);
    return null;
  }
}

/** A failed read stops the action: it is the only way to know what it would discard. */
export const UNSAVED_READ_FAILED =
  "Couldn't check this plugin's panels for unsaved work, so nothing changed. Try again.";

export function unsavedPanelKey(panel: PluginUnsavedPanel): string {
  return `${panel.projectId ?? ""}\u0000${panel.panelId}`;
}

/**
 * Whether `current` names a dirty panel the user wasn't shown. A panel saved or
 * closed since only shrinks what is lost, so it never asks again.
 */
export function hasUnshownPanels(
  current: readonly PluginUnsavedPanel[],
  shown: readonly PluginUnsavedPanel[]
): boolean {
  const seen = new Set(shown.map(unsavedPanelKey));
  return current.some((panel) => !seen.has(unsavedPanelKey(panel)));
}
