import { useEffect, useMemo, useState } from "react";
import {
  PROJECT_PLUGIN_INSTANCE_PREFIX,
  type LoadedPluginInfo,
  type ProjectPluginInfo,
} from "@shared/types/plugin";
import { settingsForHome } from "@/services/plugin/pluginSettingsHome";
import type { PluginSettingsHome } from "@/store/pluginManagerStore";
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

/**
 * One search row per declared setting, filed under the home that shows it.
 * Only labels and descriptions are indexed: defaults, stored values and options
 * stay out, which is what keeps a secret field's contents unsearchable.
 */
export function buildPluginSettingsSearchEntries(
  plugins: readonly SearchablePlugin[]
): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const { plugin, name } of plugins) {
    for (const home of ["manager", "project"] as const) {
      for (const def of settingsForHome(plugin, home)) {
        entries.push({
          id: `plugin:${plugin.instanceId}:${def.id}`,
          ...HOME_ENTRY[home],
          kind: "section",
          section: name,
          title: def.label ?? def.id,
          description: def.description ?? "",
          keywords: [name],
          plugin: { instanceId: plugin.instanceId, settingId: def.id },
        });
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
    } else {
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
