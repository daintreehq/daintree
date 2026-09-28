import {
  getPanelKindConfig,
  getPanelKindIds,
  onPanelKindRegistered,
} from "@shared/config/panelKindRegistry";
import { notify } from "@/lib/notify";
import { pluginViewHostId } from "./remotePluginView";

/**
 * Plugin panel kinds this view has seen registered. A placeholder for a kind in
 * here is a plugin the host removed while its panel was open; one that never
 * registered is a saved panel restored onto a host that never had it.
 */
const seenKinds = new Set<string>();
const announcedPlugins = new Set<string>();
let tracking = false;

function track(kindId: string, extensionId: string | undefined): void {
  if (extensionId !== undefined) seenKinds.add(kindId);
}

/** Start remembering plugin panel kinds; a no-op outside a window on another machine. */
export function trackPluginPanelKinds(): void {
  if (tracking || pluginViewHostId() === null) return;
  tracking = true;
  for (const kindId of getPanelKindIds()) track(kindId, getPanelKindConfig(kindId)?.extensionId);
  onPanelKindRegistered((config) => {
    track(config.id, config.extensionId);
    // Back on the host: a later removal is news again.
    if (config.extensionId !== undefined) announcedPlugins.delete(config.extensionId);
  });
}

trackPluginPanelKinds();

/**
 * One toast per plugin when the host removes it under an open panel, however
 * many of its panels this view shows. A restored panel whose plugin was never
 * here gets only its placeholder.
 */
export function announcePluginRemovedFromHost(
  kindId: string,
  pluginId: string,
  pluginName: string,
  hostName: string
): boolean {
  if (!seenKinds.has(kindId) || announcedPlugins.has(pluginId)) return false;
  announcedPlugins.add(pluginId);
  notify({
    type: "warning",
    title: "Plugin removed",
    message: `${pluginName} was removed from ${hostName}. Its panels stay open until you close them.`,
    rateLimitKey: `plugin-removed-from-host:${pluginId}`,
    context: { eventKind: "connectivity" },
  });
  return true;
}

export function _resetPluginPanelRemovalForTesting(): void {
  seenKinds.clear();
  announcedPlugins.clear();
  tracking = false;
}
