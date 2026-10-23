import {
  parseProjectPluginInstanceKey,
  type LoadedPluginInfo,
  type PluginSettingsScope,
  type SettingDefinition,
  type ViewContribution,
} from "@shared/types/plugin";
import type { PluginSettingsHome, PluginSettingsSection } from "@/store/pluginManagerStore";

export interface PluginSettingsTarget {
  plugin: LoadedPluginInfo;
  home: PluginSettingsHome;
  /** The requested key when it names a declared setting; otherwise absent. */
  key?: string;
  /** The requested section when the plugin has it in `home`; otherwise absent. */
  section?: PluginSettingsSection;
  /** The requested page of the custom section when the view declares it. */
  page?: string;
}

/**
 * Where inside a plugin's settings a request asks to land, beyond a declared
 * key: one of the sections a home shows, a page of the custom section, and —
 * for the parts an installed plugin shows in both homes — which home.
 */
export interface PluginSettingsDestination {
  section?: PluginSettingsSection;
  page?: string;
  scope?: "user" | "project";
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
 * Whether a forge provider of the plugin ships its own Code forge settings tab.
 * Project settings then shows an installed plugin as a pointer there in place
 * of its form, so nothing in that form is a place to land.
 */
export function forgeOwnsProjectSettings(plugin: LoadedPluginInfo): boolean {
  return (plugin.manifest.contributes.forgeProviders ?? []).some(
    (provider) => provider.slots?.settingsTab
  );
}

/** The plugin's `location: "settings"` view, when it declares one. */
export function settingsViewOf(plugin: LoadedPluginInfo): ViewContribution | undefined {
  return (plugin.manifest.contributes.views ?? []).find((view) => view.location === "settings");
}

/**
 * Which homes mount the custom settings section: a project plugin's only in its
 * project, an installed plugin's in both, each with its own scope.
 */
export function settingsViewHomesOf(plugin: LoadedPluginInfo): PluginSettingsHome[] {
  if (!pluginDeclaresSettingsView(plugin)) return [];
  return plugin.origin === "project" ? ["project"] : ["manager", "project"];
}

/**
 * Whether a home shows anything of this plugin's — fields, the custom section,
 * the account or the setup checklist.
 */
export function homeHasSettings(plugin: LoadedPluginInfo, home: PluginSettingsHome): boolean {
  return (
    settingsForHome(plugin, home).length > 0 ||
    settingsViewHomesOf(plugin).includes(home) ||
    accountHomeOf(plugin) === home ||
    setupHomeOf(plugin) === home
  );
}

/**
 * Whether a plugin has anything a settings home would show. Read off the
 * manifest rather than the running instance, so a stopped plugin's settings are
 * still reachable (its custom section then says it needs the plugin running).
 */
export function pluginHasSettings(plugin: LoadedPluginInfo): boolean {
  return (
    (plugin.manifest.contributes.settings?.length ?? 0) > 0 ||
    pluginDeclaresSettingsView(plugin) ||
    plugin.manifest.contributes.account !== undefined ||
    (plugin.manifest.contributes.setup?.length ?? 0) > 0
  );
}

/**
 * Where a plugin's `contributes.account` row lives, or `null` when it declares
 * none. A project plugin's account belongs to its project; an installed
 * plugin's is this machine's, so it sits with the plugin's own settings in the
 * plugin manager.
 */
export function accountHomeOf(plugin: LoadedPluginInfo): PluginSettingsHome | null {
  if (plugin.manifest.contributes.account === undefined) return null;
  return plugin.origin === "project" ? "project" : "manager";
}

/**
 * Where a plugin's `contributes.setup` checklist sits at the top of the
 * settings, or `null` when it declares none: beside its account, for the same
 * reason.
 */
export function setupHomeOf(plugin: LoadedPluginInfo): PluginSettingsHome | null {
  if ((plugin.manifest.contributes.setup?.length ?? 0) === 0) return null;
  return plugin.origin === "project" ? "project" : "manager";
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
 * manager would have nothing to show. A `destination` can name a section, a
 * page of the custom section, and for what an installed plugin shows in both
 * homes (its custom section, its settings as a whole) the home by scope.
 *
 * A project-scoped destination with no project open is refused rather than
 * rerouted: the manager does not show those fields, so sending the user there
 * would land them somewhere the setting isn't.
 */
export function resolvePluginSettingsTarget(
  requested: string,
  key: string | undefined,
  plugins: readonly LoadedPluginInfo[],
  projectId: string | null,
  destination: PluginSettingsDestination = {}
): PluginSettingsResolution {
  const plugin = findPlugin(requested, plugins, projectId);
  if (plugin === "ambiguous") return { ok: false, reason: "ambiguous" };
  if (!plugin) return { ok: false, reason: "not-found" };
  if (!pluginHasSettings(plugin)) return { ok: false, reason: "no-settings" };
  const def =
    key === undefined ? undefined : plugin.manifest.contributes.settings?.find((s) => s.id === key);
  // A declared key decides its own home; a section only where the plugin has
  // it. Anything else is dropped, like an undeclared key, and the request
  // falls back to the plugin's settings as a whole.
  const section = def ? undefined : sectionHomes(plugin, destination.section);
  let home: PluginSettingsHome;
  if (plugin.origin === "project") {
    home = "project";
  } else if (def) {
    home = settingScopeOf(def) === "user" ? "manager" : "project";
  } else if (section !== undefined && section.homes.length === 1) {
    home = section.homes[0]!;
  } else {
    // The custom section, or the plugin as a whole: the home the request asks
    // for when it shows something there, else the manager unless it has nothing.
    const asked: PluginSettingsHome | undefined =
      destination.scope === undefined
        ? undefined
        : destination.scope === "user"
          ? "manager"
          : "project";
    const candidates = section?.homes ?? (["manager", "project"] as const);
    home =
      asked !== undefined && candidates.includes(asked) && homeHasSettings(plugin, asked)
        ? asked
        : candidates.includes("manager") && homeHasSettings(plugin, "manager")
          ? "manager"
          : "project";
  }
  if (home === "project" && projectId === null) return { ok: false, reason: "needs-project" };
  const target: PluginSettingsTarget = { plugin, home };
  if (def) target.key = def.id;
  if (section !== undefined) {
    target.section = section.section;
    const page = destination.page;
    if (
      section.section === "custom" &&
      page !== undefined &&
      settingsViewOf(plugin)?.pages?.some((p) => p.id === page)
    ) {
      target.page = page;
    }
  }
  return { ok: true, target };
}

/** The homes a requested section is shown in, or undefined when the plugin has none. */
function sectionHomes(
  plugin: LoadedPluginInfo,
  section: PluginSettingsSection | undefined
): { section: PluginSettingsSection; homes: PluginSettingsHome[] } | undefined {
  if (section === undefined) return undefined;
  const homes =
    section === "account"
      ? [accountHomeOf(plugin)]
      : section === "setup"
        ? [setupHomeOf(plugin)]
        : settingsViewHomesOf(plugin);
  const present = homes.filter((h): h is PluginSettingsHome => h !== null);
  return present.length === 0 ? undefined : { section, homes: present };
}
