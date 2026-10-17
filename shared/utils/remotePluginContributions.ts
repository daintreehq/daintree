import { BUILT_IN_ACTION_IDS, DENY_PLUGIN_DISPATCH_ACTION_IDS } from "../config/actionIds.js";
import { KEY_ACTION_VALUES } from "../types/keymap.js";

const DENIED: ReadonlySet<string> = new Set(DENY_PLUGIN_DISPATCH_ACTION_IDS);
const BUILT_IN: ReadonlySet<string> = new Set([...BUILT_IN_ACTION_IDS, ...KEY_ACTION_VALUES]);

/**
 * Whether a keybinding, toolbar button or context-menu item a host's plugin
 * contributes may name `actionId` in this machine's window. The host checks
 * this when it reads the manifest, but a host that doesn't is another machine,
 * so the window it shows up in checks again: never an action closed to plugin
 * dispatch (terminal input, the clipboard into a terminal), only built-ins or
 * the plugin's own namespace.
 */
export function isRemoteContributionActionAllowed(pluginId: string, actionId: string): boolean {
  if (DENIED.has(actionId)) return false;
  if (BUILT_IN.has(actionId)) return true;
  return isOwnPluginAction(pluginId, actionId);
}

/**
 * Whether `actionId` is one the plugin itself registers: actions are
 * namespaced by the plugin's runtime instance id (a project plugin's carries
 * its project), so another plugin's action, global or project, never matches.
 */
export function isOwnPluginAction(pluginId: string, actionId: string): boolean {
  return pluginId.length > 0 && actionId.startsWith(`${pluginId}.`);
}
