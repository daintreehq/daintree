/**
 * Plugin-shipped SVG icons (#13143). A plugin opts in by writing a relative
 * path where a generic icon id would go — `"iconId": "./icons/flutter.svg"` on
 * a panel, toolbar button or process tool — rather than through a new manifest
 * key. Every contribution schema is `.strict()`, so a sibling key would make an
 * older host reject the whole manifest; a path in `iconId` is just an
 * unrecognized id there, and renders the fallback glyph like any other.
 *
 * Pure data and string helpers with no imports: main, the renderer and the
 * standalone `daintree-plugin` CLI all bundle this module.
 */

/**
 * Longest reference honoured. Matches the `processTools[].iconId` schema cap,
 * so a reference that works on one contribution type works on all three and
 * still parses on an older host.
 */
export const PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH = 64;

/** Largest SVG file, in bytes, the host will read for a custom icon. */
export const PLUGIN_CUSTOM_ICON_MAX_BYTES = 64 * 1024;

/**
 * Prefix of the runtime key main mints for a loaded custom icon. The colon
 * keeps it disjoint from every generic, agent and process-tool id, which matters
 * because a detected process's icon id doubles as its identity.
 */
export const PLUGIN_CUSTOM_ICON_KEY_PREFIX = "plugin-icon:";

/**
 * Whether `iconId` is written in the custom-icon form. Deliberately loose — any
 * `./…` value counts — so a malformed path gets a targeted error from
 * {@link validatePluginCustomIconRef} instead of the generic unknown-id advisory.
 */
export function isPluginCustomIconRef(iconId: string | null | undefined): iconId is string {
  return typeof iconId === "string" && iconId.startsWith("./");
}

/**
 * Why `ref` can't name a custom icon, or `null` when it can. Accepts
 * `./dir/name.svg` with POSIX separators; rejects anything that could resolve
 * outside the plugin directory or carry URL syntax.
 */
export function validatePluginCustomIconRef(ref: string): string | null {
  if (!ref.startsWith("./")) return 'must start with "./"';
  if (ref.length > PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH) {
    return `must be at most ${PLUGIN_CUSTOM_ICON_MAX_REF_LENGTH} characters`;
  }
  if (!ref.endsWith(".svg")) return 'must name an ".svg" file (lowercase extension)';
  if (/[\\?#%:]/.test(ref)) return "must not contain backslashes, URL syntax (?, #, %) or colons";
  for (let i = 0; i < ref.length; i++) {
    if (ref.charCodeAt(i) < 0x20 || ref.charCodeAt(i) === 0x7f) {
      return "must not contain control characters";
    }
  }
  const segments = ref.slice(2).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return 'must not contain empty, "." or ".." path segments';
  }
  return null;
}

/**
 * The runtime key for `ref` loaded by the plugin instance `pluginId`.
 * Lower-cased because a process tool's key travels as a detected process id,
 * which terminal chrome lower-cases before looking it up.
 */
export function makePluginCustomIconKey(pluginId: string, ref: string): string {
  return `${PLUGIN_CUSTOM_ICON_KEY_PREFIX}${pluginId}:${ref}`.toLowerCase();
}

/** Whether `iconId` is a runtime key minted by {@link makePluginCustomIconKey}. */
export function isPluginCustomIconKey(iconId: string | null | undefined): iconId is string {
  return typeof iconId === "string" && iconId.startsWith(PLUGIN_CUSTOM_ICON_KEY_PREFIX);
}

/** Whether `key` was minted for `pluginId` — and not for another plugin. */
export function isPluginCustomIconKeyOwnedBy(key: string, pluginId: string): boolean {
  return key.startsWith(`${PLUGIN_CUSTOM_ICON_KEY_PREFIX}${pluginId}:./`.toLowerCase());
}

/** One loaded custom icon as the renderer receives it. */
export interface PluginCustomIconAsset {
  /** Runtime key from {@link makePluginCustomIconKey}. */
  key: string;
  /** Owning plugin instance id. */
  pluginId: string;
  /** Owning plugin's display name, for labels that would otherwise show the key. */
  pluginName: string;
  /** Sanitized SVG markup. Rendered only as a CSS mask image, never as DOM. */
  svg: string;
}
