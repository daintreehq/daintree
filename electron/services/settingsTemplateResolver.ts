/**
 * Minimal settings read surface consumed by the template resolver. This is a
 * structural subset of the full `host.settings` `SettingsApi` (shared/types/
 * plugin.ts, #9279) — a real `SettingsApi` satisfies it, since its `get` widens
 * to an optional `scope` argument and a generic return. Kept narrow here so the
 * resolver only depends on the read it actually performs.
 */
export interface PluginSettingsApi {
  get(key: string): Promise<string | undefined>;
}

export class SettingTemplateError extends Error {
  public readonly code = "UNMATCHED_SETTING";
  public readonly pluginId: string;
  public readonly token: string;

  constructor(pluginId: string, token: string) {
    super(`Unmatched setting template "${token}" for plugin "${pluginId}"`);
    this.name = "SettingTemplateError";
    this.pluginId = pluginId;
    this.token = token;
  }
}

// The id grammar mirrors what a declared setting `id` can actually contain:
// the manifest schema (electron/schemas/plugin.ts) accepts any non-empty string,
// and the author CLI matches `[^}]+` (packages/daintree-plugin validate). Matching
// the same run of non-`}` characters here keeps the three in lockstep — a valid id
// like `linear-api-token` shows in the UI AND substitutes, instead of silently
// passing through unresolved. `${settings:}` still fails to match (empty id).
const SETTINGS_TEMPLATE_RE = /(?<!\\)\$\{settings:([^}]+)\}/g;

/**
 * Scan `text` for `${settings:<id>}` templates and substitute each with the
 * value from the plugin-scoped settings API. Throws `SettingTemplateError` if
 * any referenced setting is not configured — never silently falls back to an
 * empty string.
 *
 * Near-miss syntax (`$settings:foo`, `${settings:}`, `${other:foo}`) passes
 * through as literal text — only a non-empty id between the braces matches.
 * Escaped `\${settings:foo}` is left unchanged.
 */
export async function resolveSettingsTemplates(
  text: string,
  pluginId: string,
  settings: PluginSettingsApi
): Promise<string> {
  const matches = [...text.matchAll(SETTINGS_TEMPLATE_RE)];
  if (matches.length === 0) return text;

  const uniqueIds = new Map<string, string>();

  for (const match of matches) {
    const settingId = match[1];
    if (!uniqueIds.has(settingId)) {
      uniqueIds.set(settingId, settingId);
    }
  }

  const results = await Promise.all(
    [...uniqueIds.keys()].map(async (id) => {
      let value: string | undefined;
      try {
        value = await settings.get(id);
      } catch {
        throw new SettingTemplateError(pluginId, id);
      }
      if (value === undefined) {
        throw new SettingTemplateError(pluginId, id);
      }
      return { id, value };
    })
  );

  const resolved = new Map<string, string>();
  for (const { id, value } of results) {
    resolved.set(id, value);
  }

  return text.replace(SETTINGS_TEMPLATE_RE, (_match, id) => {
    const value = resolved.get(id);
    if (value === undefined) {
      throw new SettingTemplateError(pluginId, id);
    }
    return value;
  });
}
