import { useEffect, useMemo, useState } from "react";
import {
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  type LoadedPluginInfo,
  type ProjectPluginInfo,
} from "@shared/types/plugin";
import {
  accountHomeOf,
  forgeOwnsProjectSettings,
  homeHasSettings,
  settingsForHome,
  settingsViewHomesOf,
  settingsViewOf,
  setupHomeOf,
} from "@/services/plugin/pluginSettingsHome";
import type { SettingRef } from "@/hooks/useSettingsOwner";
import type { PluginSettingsHome } from "@/store/pluginManagerStore";
import { declaredPluginConnections } from "@shared/utils/pluginConnections";
import { useProjectPluginStore } from "@/store/projectPluginStore";
import { logError } from "@/utils/logger";
import { SETTINGS_SEARCH_INDEX, type SettingsSearchEntry } from "./settingsSearchIndex";

export interface SearchablePlugin {
  plugin: LoadedPluginInfo;
  name: string;
}

const HOME_ENTRY = {
  manager: { tab: "plugins", scope: "global", tabLabel: "Plugin manager" },
  project: { tab: "project:plugins", scope: "project", tabLabel: "Plugins" },
} as const satisfies Record<
  PluginSettingsHome,
  Pick<SettingsSearchEntry, "tab" | "scope" | "tabLabel">
>;

/** The `settingsContext.scope` each home mounts a custom section with. */
const HOME_SCOPE = { manager: "user", project: "project" } as const satisfies Record<
  PluginSettingsHome,
  "user" | "project"
>;

/** Plugins and what they keep are the host's. */
const PLUGIN_SETTINGS: readonly SettingRef[] = ["plugins"];

/**
 * The search rows for each plugin, filed under the home that shows each one:
 * the home itself, its setup steps, its account, every declared setting, and
 * its custom section with the section's declared pages. A plugin with only an
 * account, a checklist or a custom section is still found, by its name and by
 * what the manifest calls those parts.
 *
 * Only manifest display text is indexed — names, labels, titles and
 * descriptions. Defaults, stored values, options, account endpoints and
 * identities, and what a setup step observed stay out, which is what keeps a
 * secret field's contents unsearchable.
 */
export function buildPluginSettingsSearchEntries(
  plugins: readonly SearchablePlugin[]
): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const { plugin, name } of plugins) {
    const { instanceId } = plugin;
    // The account section, found by its first connection's name.
    const account = declaredPluginConnections(plugin.manifest)[0];
    const setup = plugin.manifest.contributes.setup ?? [];
    const view = settingsViewOf(plugin);
    const viewHomes = settingsViewHomesOf(plugin);
    for (const home of ["manager", "project"] as const) {
      if (!homeHasSettings(plugin, home)) continue;
      const scope = HOME_SCOPE[home];
      const row = (
        id: string,
        title: string,
        description: string | undefined,
        target: Omit<NonNullable<SettingsSearchEntry["plugin"]>, "instanceId">,
        keywords: readonly string[] = []
      ): SettingsSearchEntry => ({
        id: `plugin:${instanceId}:${id}`,
        ...HOME_ENTRY[home],
        kind: "section",
        section: name,
        title,
        description: description ?? "",
        keywords: [name, ...keywords],
        settings: PLUGIN_SETTINGS,
        plugin: { instanceId, ...target },
      });
      // A forge plugin that keeps its settings in Code forge shows only a
      // pointer there: the home is still a result, nothing inside it is.
      const homeOnly =
        home === "project" && plugin.origin !== "project" && forgeOwnsProjectSettings(plugin);
      entries.push(
        row(
          `@home:${home}`,
          name,
          plugin.manifest.description,
          // The installed plugin's other home is a scope away; a project
          // plugin has only the one.
          plugin.origin === "project" ? {} : { scope },
          ["plugin", "settings"]
        )
      );
      if (homeOnly) continue;
      if (setupHomeOf(plugin) === home) {
        for (const step of setup) {
          entries.push(
            row(`@setup:${step.id}`, step.title, step.description, { section: "setup" }, ["setup"])
          );
        }
      }
      if (account !== undefined && accountHomeOf(plugin) === home) {
        entries.push(
          row("@account", account.label, account.description, { section: "account" }, [
            "account",
            "connection",
            "connect",
            "sign in",
          ])
        );
      }
      for (const def of settingsForHome(plugin, home)) {
        entries.push(row(def.id, def.label ?? def.id, def.description, { settingId: def.id }));
      }
      if (view !== undefined && viewHomes.includes(home)) {
        entries.push(
          row(`@custom:${home}`, view.title ?? "More settings", view.description, {
            section: "custom",
            scope,
          })
        );
        for (const page of view.pages ?? []) {
          entries.push(
            row(`@page:${home}:${page.id}`, page.title, page.description, {
              section: "custom",
              page: page.id,
              scope,
            })
          );
        }
      }
    }
  }
  return entries;
}

/**
 * The plugins whose settings this project can reach: every installed plugin,
 * and a project plugin only while it is running here — a stopped or untrusted
 * one has no form to land in.
 */
export function selectSearchablePlugins(
  loaded: readonly LoadedPluginInfo[],
  projectPlugins: readonly ProjectPluginInfo[],
  folderTrusted: boolean
): SearchablePlugin[] {
  const running = new Map(
    projectPlugins
      .filter((p) => folderTrusted && !p.muted && p.state === "active" && p.instanceId)
      .map((p) => [p.instanceId, p] as const)
  );
  const result: SearchablePlugin[] = [];
  for (const plugin of loaded) {
    if (plugin.instanceId.startsWith(PROJECT_PLUGIN_INSTANCE_PREFIX)) {
      const project = running.get(plugin.instanceId);
      if (project) result.push({ plugin, name: project.displayName });
    } else if (plugin.instanceMode !== "project") {
      // A per-project package's settings belong to its instances, not to the package row.
      result.push({ plugin, name: plugin.manifest.displayName ?? plugin.instanceId });
    }
  }
  return result;
}

/** The static index plus the visible plugins' settings; the same array until they change. */
export function usePluginSettingsSearchIndex(enabled: boolean): SettingsSearchEntry[] {
  const projectPlugins = useProjectPluginStore((s) => s.plugins);
  const folderTrusted = useProjectPluginStore((s) => s.trust?.enabled === true);
  const [loaded, setLoaded] = useState<LoadedPluginInfo[]>([]);

  // Pull-and-resubscribe like the plugin pages: install, uninstall and enable
  // arrive as provenance changes, a project plugin's own lifecycle as a store change.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      window.electron.plugin
        .list()
        .then((list) => {
          if (!cancelled) setLoaded(list);
        })
        .catch((err) => {
          if (!cancelled) logError("Failed to load plugins for settings search", err);
        });
    };
    load();
    const unsubscribe = window.electron.plugin.onProvenanceChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, projectPlugins]);

  return useMemo(() => {
    const entries = buildPluginSettingsSearchEntries(
      selectSearchablePlugins(loaded, projectPlugins, folderTrusted)
    );
    return entries.length === 0 ? SETTINGS_SEARCH_INDEX : [...SETTINGS_SEARCH_INDEX, ...entries];
  }, [loaded, projectPlugins, folderTrusted]);
}
