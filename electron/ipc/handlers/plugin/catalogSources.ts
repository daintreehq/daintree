import { CHANNELS } from "../../channels.js";
import { broadcastToRenderer } from "../../utils.js";
import type {
  PluginCatalogSourceAddResult,
  PluginCatalogSources,
} from "../../../../shared/types/plugin.js";

/**
 * The plugin catalogs this machine's person added beside Daintree's own
 * (#17434). Shell channels: the list is theirs wherever the window is
 * attached. Lazy, so nothing about added catalogs loads until the settings
 * page or Browse asks.
 */
function loadSources() {
  return import("../../../services/plugin/pluginCatalogSources.js");
}

function broadcastSourcesChanged(): void {
  broadcastToRenderer(CHANNELS.EVENTS_PUSH, {
    name: "plugin:catalog-sources-changed",
    payload: {},
  });
}

export async function handleGetCatalogSources(): Promise<PluginCatalogSources> {
  const { getPluginCatalogSources } = await loadSources();
  return { sources: getPluginCatalogSources() };
}

export async function handleAddCatalogSource(url: string): Promise<PluginCatalogSourceAddResult> {
  const { addPluginCatalogSource } = await loadSources();
  const result = addPluginCatalogSource(url);
  if (result.status === "added") broadcastSourcesChanged();
  return result;
}

export async function handleRemoveCatalogSource(url: string): Promise<PluginCatalogSources> {
  const { getPluginCatalogSources, removePluginCatalogSource } = await loadSources();
  const before = getPluginCatalogSources().length;
  const sources = removePluginCatalogSource(url);
  if (sources.length !== before) broadcastSourcesChanged();
  return { sources };
}
