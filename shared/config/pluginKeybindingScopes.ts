/**
 * The key scopes a plugin manifest may name for a keybinding. This is the
 * plugin contract, owned here rather than borrowed from the app's own
 * `KeyScope`, so a scope the app retires stays loadable in manifests that still
 * declare it (#17245). Order matches the published JSON schemas.
 */
export const PLUGIN_KEYBINDING_SCOPES = [
  "global",
  "portal",
  "worktreeGrid",
  "dev-preview",
] as const;

/**
 * Scopes a manifest may still declare but that never activate for a plugin
 * binding. Such a binding is dropped, never remapped: under `global` the same
 * combo would fire everywhere, which is not the key the author bound.
 */
export const RETIRED_PLUGIN_KEYBINDING_SCOPES = ["portal"] as const;

export type PluginKeybindingScope = (typeof PLUGIN_KEYBINDING_SCOPES)[number];
export type RetiredPluginKeybindingScope = (typeof RETIRED_PLUGIN_KEYBINDING_SCOPES)[number];
export type LivePluginKeybindingScope = Exclude<
  PluginKeybindingScope,
  RetiredPluginKeybindingScope
>;

const RETIRED_SCOPES: ReadonlySet<string> = new Set(RETIRED_PLUGIN_KEYBINDING_SCOPES);

export function isRetiredPluginKeybindingScope(
  scope: string | undefined
): scope is RetiredPluginKeybindingScope {
  return scope !== undefined && RETIRED_SCOPES.has(scope);
}

/**
 * One wording for validation and the plugin's own log, so an author sees the
 * same explanation from `daintree-plugin validate` and from diagnostics.
 */
export function retiredKeybindingScopeMessage(
  index: number,
  combo: string,
  scope: RetiredPluginKeybindingScope
): string {
  return `keybindings[${index}] ("${combo}") uses the retired "${scope}" scope — it loads but never fires, and is not moved to another scope. Remove it, or bind the key under a live scope.`;
}
