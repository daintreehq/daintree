import type { AppColorScheme } from "@shared/theme";

/** The parts of the app theme store a theme id can resolve against beyond the built-ins. */
export interface SelectableSchemeSources {
  customSchemes?: readonly AppColorScheme[];
  pluginSchemes?: readonly AppColorScheme[];
  pluginSnapshotScheme?: AppColorScheme | null;
}

const EMPTY: readonly AppColorScheme[] = [];

let cachedCustom: readonly AppColorScheme[] | undefined;
let cachedPlugin: readonly AppColorScheme[] | undefined;
let cachedSnapshot: AppColorScheme | null | undefined;
let cachedResult: AppColorScheme[] = [];

/**
 * Every non-built-in theme an id can name, in resolution order: imported
 * themes, then the plugin catalog (#13832), then the persisted plugin theme
 * while its plugin has yet to load. Imported themes come first so a plugin
 * theme can never shadow one.
 *
 * Memoized on its inputs' identities so it can be passed straight to the store
 * hook as a selector.
 */
export function selectSelectableSchemes(state: SelectableSchemeSources): AppColorScheme[] {
  const custom = state.customSchemes ?? EMPTY;
  const plugin = state.pluginSchemes ?? EMPTY;
  const snapshot = state.pluginSnapshotScheme ?? null;
  if (custom === cachedCustom && plugin === cachedPlugin && snapshot === cachedSnapshot) {
    return cachedResult;
  }
  const result = [...custom, ...plugin];
  if (snapshot && !result.some((scheme) => scheme.id === snapshot.id)) result.push(snapshot);
  cachedCustom = custom;
  cachedPlugin = plugin;
  cachedSnapshot = snapshot;
  cachedResult = result;
  return result;
}
