import {
  parseProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginSettingsScope,
} from "@shared/types/plugin";
import type { PluginSettingsHome } from "@/store/pluginManagerStore";

export interface PluginSettingsTarget {
  plugin: LoadedPluginInfo;
  home: PluginSettingsHome;
  /** The requested key when it names a declared setting; otherwise absent. */
  key?: string;
}

/** Whether a plugin has anything its settings home would show. */
export function pluginHasSettings(plugin: LoadedPluginInfo): boolean {
  return (
    (plugin.manifest.contributes.settings?.length ?? 0) > 0 || plugin.settingsViewPath !== undefined
  );
}

/**
 * Find the plugin a settings request names. `requested` is the instance key a
 * plugin's own host passes, or the manifest id an author or agent knows.
 *
 * A project instance is only ever this project's: another project's instance
 * key names a project the caller does not own, and its settings could not be
 * shown here anyway. For a bare manifest id the project's own plugin wins over
 * an installed one of the same id — inside a project, that is the one in play.
 */
function findPlugin(
  requested: string,
  plugins: readonly LoadedPluginInfo[],
  projectId: string | null
): LoadedPluginInfo | undefined {
  const ownProject = (p: LoadedPluginInfo) => p.origin === "project" && p.projectId === projectId;
  if (parseProjectPluginInstanceKey(requested) !== null) {
    return plugins.find((p) => p.instanceId === requested && ownProject(p));
  }
  return (
    plugins.find((p) => ownProject(p) && p.manifest.name === requested) ??
    plugins.find((p) => p.origin === "global" && p.instanceId === requested)
  );
}

/**
 * Resolve a settings request to the one home it lives in. Nothing new is
 * invented here — each plugin already has exactly one home per scope:
 *
 * - a project plugin's settings are in Project settings → Plugins;
 * - an installed plugin's project-scoped key (`project` or `local`) is too,
 *   while a project is open to hold it;
 * - everything else of an installed plugin is in the plugin manager.
 */
export function resolvePluginSettingsTarget(
  requested: string,
  key: string | undefined,
  plugins: readonly LoadedPluginInfo[],
  projectId: string | null
): PluginSettingsTarget | null {
  const plugin = findPlugin(requested, plugins, projectId);
  if (!plugin) return null;
  const def =
    key === undefined ? undefined : plugin.manifest.contributes.settings?.find((s) => s.id === key);
  const scope: PluginSettingsScope | undefined = def ? (def.scope ?? "user") : undefined;
  const projectScoped = scope === "project" || scope === "local";
  const home: PluginSettingsHome =
    plugin.origin === "project" || (projectScoped && projectId !== null) ? "project" : "manager";
  return def ? { plugin, home, key: def.id } : { plugin, home };
}
