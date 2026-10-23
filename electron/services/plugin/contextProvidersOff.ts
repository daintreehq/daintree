import { store } from "../../store.js";

/**
 * The plugins whose `@` context providers the user switched off (#13795), as
 * plugin instance ids. An installed plugin's instance id is the same in every
 * project, so its switch is too; a project plugin's embeds its project, so its
 * switch applies to that project alone.
 *
 * Daintree's own settings, never the repository, so a project plugin cannot
 * switch anyone else's provider off. An id whose plugin has since gone is
 * kept: the provider stays off if the plugin comes back.
 *
 * No in-memory copy: reads happen on a menu or a send, writes on a click.
 */
const STORE_KEY = "pluginContextProvidersOff";

/** The file is user-editable, so it is bounded on read as well as on write. */
const MAX_OFF_PLUGINS = 500;
export const MAX_CONTEXT_PROVIDER_PLUGIN_ID_LENGTH = 300;

export function isContextProviderPluginId(id: unknown): id is string {
  return (
    typeof id === "string" && id.length > 0 && id.length <= MAX_CONTEXT_PROVIDER_PLUGIN_ID_LENGTH
  );
}

function readOff(): string[] {
  const stored = store.get(STORE_KEY) as unknown;
  if (!Array.isArray(stored)) return [];
  const ids = new Set<string>();
  for (const id of stored) {
    if (isContextProviderPluginId(id)) ids.add(id);
    if (ids.size >= MAX_OFF_PLUGINS) break;
  }
  return [...ids];
}

export function getContextProvidersOff(): ReadonlySet<string> {
  return new Set(readOff());
}

/**
 * Switch a plugin's context providers on or off. Throws rather than quietly
 * leaving one on when the list is already full.
 */
export function setContextProvidersEnabled(pluginId: string, enabled: boolean): void {
  const current = readOff();
  if (current.includes(pluginId) === !enabled) return;
  if (!enabled && current.length >= MAX_OFF_PLUGINS) {
    throw new Error(`context providers: already ${MAX_OFF_PLUGINS} plugins switched off`);
  }
  store.set(STORE_KEY, enabled ? current.filter((id) => id !== pluginId) : [...current, pluginId]);
}
