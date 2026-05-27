/**
 * Minimal settings read surface consumed by the template resolver. #9279 will
 * replace this with the full `host.settings` API.
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

const SETTINGS_TEMPLATE_RE =
  /(?<!\\)\$\{settings:([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g;

/**
 * Scan `text` for `${settings:<id>}` templates and substitute each with the
 * value from the plugin-scoped settings API. Throws `SettingTemplateError` if
 * any referenced setting is not configured — never silently falls back to an
 * empty string.
 *
 * Near-miss syntax (`$settings:foo`, `${settings:}`, `${other:foo}`) passes
 * through as literal text. Escaped `\${settings:foo}` is left unchanged.
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
