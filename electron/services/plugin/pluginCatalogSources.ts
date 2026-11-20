import { PLUGIN_CATALOG_SOURCES_MAX } from "../../../shared/config/pluginCatalog.js";
import type { PluginCatalogSourceAddResult } from "../../../shared/types/plugin.js";
import { store } from "../../store.js";
import { canonicalCatalogSourceUrl } from "./pluginCatalogSourceUrl.js";

/**
 * The plugin catalogs the person added beside Daintree's own (#17434). Their
 * own settings on the machine they sit at, never a repository's, so a pull
 * can't add one; a window attached to a host carries this machine's list to
 * it. No in-memory copy: every read is fresh, so a change from any window
 * holds from the next Browse, preview or install.
 */
const STORE_KEY = "pluginCatalogSources";

/** The file is user-editable, so a value is checked again on every read. */
function parseSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const sources: string[] = [];
  for (const raw of value) {
    const result = canonicalCatalogSourceUrl(raw);
    if (result.ok && !sources.includes(result.url)) sources.push(result.url);
    if (sources.length >= PLUGIN_CATALOG_SOURCES_MAX) break;
  }
  return sources;
}

export function getPluginCatalogSources(): string[] {
  return parseSources(store.get(STORE_KEY) as unknown);
}

/** Whether `sourceUrl`, already canonical, is a catalog the person added. */
export function isAddedPluginCatalogSource(sourceUrl: string): boolean {
  return getPluginCatalogSources().includes(sourceUrl);
}

/**
 * Add a catalog to the end of the list. Read, checked and written in one
 * synchronous step, so two windows adding at once can't drop each other's.
 */
export function addPluginCatalogSource(raw: unknown): PluginCatalogSourceAddResult {
  const sources = getPluginCatalogSources();
  const result = canonicalCatalogSourceUrl(raw);
  if (!result.ok) return { status: "refused", reason: result.reason, sources };
  if (sources.includes(result.url)) return { status: "refused", reason: "duplicate", sources };
  if (sources.length >= PLUGIN_CATALOG_SOURCES_MAX) {
    return { status: "refused", reason: "too-many", sources };
  }
  const next = [...sources, result.url];
  store.set(STORE_KEY, next);
  return { status: "added", sourceUrl: result.url, sources: next };
}

/**
 * Take a catalog off the list. Installs from it keep checking it for updates:
 * their records name it, and an update never moves to another catalog.
 */
export function removePluginCatalogSource(raw: unknown): string[] {
  const sources = getPluginCatalogSources();
  const result = canonicalCatalogSourceUrl(raw);
  if (!result.ok || !sources.includes(result.url)) return sources;
  const next = sources.filter((url) => url !== result.url);
  store.set(STORE_KEY, next);
  return next;
}
