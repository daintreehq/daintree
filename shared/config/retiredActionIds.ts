/**
 * Built-in action ids Daintree no longer has. A plugin manifest may still name
 * one in a contribution: it loads, that contribution is dropped and never
 * remapped, and validation and diagnostics say why, as for a retired key scope
 * (#17245). The Portal dock's went with it (#17256). An id here is never reused.
 */
export const RETIRED_BUILT_IN_ACTION_IDS = [
  "panel.togglePortal",
  "portal.toggle",
  "portal.closeTab",
  "portal.nextTab",
  "portal.prevTab",
  "portal.newTab",
  "portal.closeAllTabs",
  "portal.activateTab",
  "portal.openLaunchpad",
  "portal.openUrl",
  "portal.goBack",
  "portal.goForward",
  "portal.reload",
  "portal.copyUrl",
  "portal.openExternal",
  "portal.duplicateTab",
  "portal.reloadTab",
  "portal.copyTabUrl",
  "portal.openTabExternal",
  "portal.closeOthers",
  "portal.closeToRight",
  "portal.resetWidth",
  "portal.width.set",
  "portal.setDefaultNewTab",
  "portal.links.add",
  "portal.links.remove",
  "portal.links.update",
  "portal.links.toggle",
  "portal.links.reorder",
  "portal.tabs.reorder",
  "portal.listTabs",
] as const;

const RETIRED: ReadonlySet<string> = new Set(RETIRED_BUILT_IN_ACTION_IDS);

/**
 * Whether `actionId` names a retired built-in. An id inside the plugin's own
 * namespace (`ownNamespacePrefix`, its name and a dot) is the plugin's own
 * command, whatever it spells.
 */
export function isRetiredBuiltInActionId(
  actionId: string | undefined,
  ownNamespacePrefix?: string
): boolean {
  if (actionId === undefined || !RETIRED.has(actionId)) return false;
  return ownNamespacePrefix === undefined || !actionId.startsWith(ownNamespacePrefix);
}

/** Contribution arrays whose entries name an action by `actionId`. */
export const ACTION_ID_CONTRIBUTIONS = [
  "toolbarButtons",
  "menuItems",
  "keybindings",
  "contextMenus",
] as const;

/**
 * One wording for validation and the plugin's own log, so an author sees the
 * same explanation from `daintree-plugin validate` and from diagnostics.
 */
export function retiredActionIdMessage(
  contribution: (typeof ACTION_ID_CONTRIBUTIONS)[number],
  index: number,
  actionId: string
): string {
  return `${contribution}[${index}] names "${actionId}", a built-in action Daintree no longer has — it loads, but the action never runs and is not moved to another. Remove it.`;
}
