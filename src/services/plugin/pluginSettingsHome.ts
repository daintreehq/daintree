import {
  parseProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginSettingsScope,
  type SettingDefinition,
} from "@shared/types/plugin";
import type { PluginSettingsHome } from "@/store/pluginManagerStore";

export interface PluginSettingsTarget {
  plugin: LoadedPluginInfo;
  home: PluginSettingsHome;
  /** The requested key when it names a declared setting; otherwise absent. */
  key?: string;
}

export type PluginSettingsResolution =
  | { ok: true; target: PluginSettingsTarget }
  | { ok: false; reason: "not-found" | "ambiguous" | "no-settings" | "needs-project" };

/** A declaration's scope, with the manifest default applied. */
export function settingScopeOf(def: SettingDefinition): PluginSettingsScope {
  return def.scope ?? "user";
}

/** Whether the manifest declares a `location: "settings"` view — running or not. */
export function pluginDeclaresSettingsView(plugin: LoadedPluginInfo): boolean {
  return (plugin.manifest.contributes.views ?? []).some((view) => view.location === "settings");
}

/**
 * Whether a plugin has anything a settings home would show. Read off the
 * manifest rather than the running instance, so a stopped plugin's settings are
 * still reachable (its custom section then says it needs the plugin running).
 */
export function pluginHasSettings(plugin: LoadedPluginInfo): boolean {
  return (
    (plugin.manifest.contributes.settings?.length ?? 0) > 0 || pluginDeclaresSettingsView(plugin)
  );
}

/**
 * Which declarations a home shows. Every plugin has one home per scope, and a
 * field appears in that home only:
 *
 * - a project plugin's fields all live in its project's settings;
 * - an installed plugin's `user` fields live in the plugin manager;
 * - an installed plugin's `project` and `local` fields live in Project settings.
 */
export function settingsForHome(
  plugin: LoadedPluginInfo,
  home: PluginSettingsHome
): SettingDefinition[] {
  const settings = plugin.manifest.contributes.settings ?? [];
  if (plugin.origin === "project") return home === "project" ? settings : [];
  return settings.filter((def) => (settingScopeOf(def) === "user") === (home === "manager"));
}

/**
 * Find the plugin a settings request names. Two forms are accepted:
 *
 * - an **instance key**, matched exactly — what a plugin's own host and the
 *   panel menus pass. An installed plugin's key is its manifest id, so it always
 *   resolves to the installed plugin, never to a project copy of the same id. A
 *   project instance key resolves only inside its own project.
 * - a **manifest id** of this project's own plugin, when no installed plugin has
 *   that id. If more than one project instance matched it would be ambiguous,
 *   and nothing is guessed.
 */
function findPlugin(
  requested: string,
  plugins: readonly LoadedPluginInfo[],
  projectId: string | null
): LoadedPluginInfo | "ambiguous" | undefined {
  const ownProject = (p: LoadedPluginInfo) => p.origin === "project" && p.projectId === projectId;
  if (parseProjectPluginInstanceKey(requested) !== null) {
    return plugins.find((p) => p.instanceId === requested && ownProject(p));
  }
  const installed = plugins.find((p) => p.origin === "global" && p.instanceId === requested);
  if (installed) return installed;
  const byManifest = plugins.filter((p) => ownProject(p) && p.manifest.name === requested);
  if (byManifest.length > 1) return "ambiguous";
  return byManifest[0];
}

/**
 * Resolve a settings request to the one home it lives in. Nothing new is
 * invented here — the homes are the ones {@link settingsForHome} describes. A
 * request for an installed plugin with no key goes to the manager, unless every
 * field it has is project-scoped and it has no custom section, in which case the
 * manager would have nothing to show.
 *
 * A project-scoped destination with no project open is refused rather than
 * rerouted: the manager does not show those fields, so sending the user there
 * would land them somewhere the setting isn't.
 */
export function resolvePluginSettingsTarget(
  requested: string,
  key: string | undefined,
  plugins: readonly LoadedPluginInfo[],
  projectId: string | null
): PluginSettingsResolution {
  const plugin = findPlugin(requested, plugins, projectId);
  if (plugin === "ambiguous") return { ok: false, reason: "ambiguous" };
  if (!plugin) return { ok: false, reason: "not-found" };
  if (!pluginHasSettings(plugin)) return { ok: false, reason: "no-settings" };
  const def =
    key === undefined ? undefined : plugin.manifest.contributes.settings?.find((s) => s.id === key);
  let home: PluginSettingsHome;
  if (plugin.origin === "project") {
    home = "project";
  } else if (def) {
    home = settingScopeOf(def) === "user" ? "manager" : "project";
  } else {
    const managerHasContent =
      settingsForHome(plugin, "manager").length > 0 || pluginDeclaresSettingsView(plugin);
    home = managerHasContent ? "manager" : "project";
  }
  if (home === "project" && projectId === null) return { ok: false, reason: "needs-project" };
  return { ok: true, target: def ? { plugin, home, key: def.id } : { plugin, home } };
}
