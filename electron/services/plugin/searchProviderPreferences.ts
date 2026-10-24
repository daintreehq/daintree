// eager-import-allow: reads hidden search providers via store.get for the synchronous search-provider filter without activating provider plugins
import { store } from "../../store.js";
import { projectIdFromPluginInstanceKey } from "../../../shared/types/plugin.js";

/**
 * The quick switcher search providers the user switched off (#13792), by
 * `{pluginId}.{provider id}` key.
 *
 * One list covers both scopes the issue asks for: a project plugin's instance
 * id already names its project, so switching one of its providers off is per
 * project, while an installed plugin's key is the same in every project. A key
 * whose plugin has gone is kept rather than pruned, so the provider stays off
 * if the plugin comes back.
 *
 * Daintree's own settings, never the repository, so no plugin can switch
 * another's provider off. No in-memory copy: reads happen when the switcher
 * opens and writes on a click.
 */
const STORE_KEY = "hiddenSearchProviders";

/** Most providers the list may hold; the file is user-editable, so it is bounded on read too. */
const MAX_HIDDEN_PROVIDERS = 500;

/** Longest key the list may hold, on read and on write alike. */
export const MAX_SEARCH_PROVIDER_KEY_LENGTH = 400;

export function isSearchProviderKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_SEARCH_PROVIDER_KEY_LENGTH;
}

/**
 * Whether a view of `projectId` may switch the provider `key` names: an
 * installed plugin's provider from any view, a project plugin's only from its
 * own project's — its key names that project, so one project can't hide
 * another's providers.
 */
export function canSetSearchProviderFrom(key: string, projectId: string | null): boolean {
  const owner = projectIdFromPluginInstanceKey(key);
  return owner === null || owner === projectId;
}

export function getHiddenSearchProviders(): string[] {
  const stored = store.get(STORE_KEY) as unknown;
  if (!Array.isArray(stored)) return [];
  const keys = new Set<string>();
  for (const key of stored) {
    if (isSearchProviderKey(key)) keys.add(key);
    if (keys.size >= MAX_HIDDEN_PROVIDERS) break;
  }
  return [...keys];
}

/**
 * Show or hide one provider in the quick switcher. Returns the hidden keys.
 * Throws rather than quietly leaving a provider on when the list is full.
 */
export function setSearchProviderShown(key: string, shown: boolean): string[] {
  const current = getHiddenSearchProviders();
  if (current.includes(key) !== shown) return current;
  if (!shown && current.length >= MAX_HIDDEN_PROVIDERS) {
    throw new Error(`search provider: already ${MAX_HIDDEN_PROVIDERS} providers are hidden`);
  }
  const next = shown ? current.filter((id) => id !== key) : [...current, key];
  store.set(STORE_KEY, next);
  return next;
}
